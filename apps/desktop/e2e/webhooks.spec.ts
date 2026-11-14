import { createHmac } from 'node:crypto';
import { type Page, expect, test } from '@playwright/test';
import type { HiveApi, WebhookTrust } from '@insectoids/shared';
import { type AppWindow, type LaunchedApp, NO_KEY_STORE, launchApp, noKeyStoreOnLinux } from './support/launch';

/**
 * Webhooks and trust (Phase 3 A4, Cadence 05-D2, D4): an outside app calls a cadence's local URL on 127.0.0.1.
 * `POST /hooks/<id>` asks the hive to run it; `POST /hooks/<id>/note` only tells it something. Every call carries
 * the webhook's secret (HMAC signature, GitHub's header, or a bearer token), and the cadence's trust mode decides
 * what happens: strict asks for everything, communication-only (the default) saves notes and asks before runs,
 * allow-all runs on its own. Every call is logged in the run history, refused ones too.
 *
 * The secret lives in the Vault, so these tests skip on a Linux runner without an OS key store. The app listens on
 * a free port (INSECTOIDS_WEBHOOK_PORT=0); the URL comes from `webhooks.info()`. Calls are made from the test
 * process with Node's fetch. The fake engine's Queen plans any goal in two waves, so a started run's plan waits.
 */
const snapshot = (win: Page) => win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.snapshot());
const command = (win: Page, cmd: Parameters<HiveApi['command']>[0]) =>
  win.evaluate((c) => (globalThis as unknown as AppWindow).insectoids.hive.command(c), cmd);
const runsOf = (win: Page, cadenceId: string) =>
  win.evaluate((id) => (globalThis as unknown as AppWindow).insectoids.hive.cadenceRuns({ cadenceId: id, limit: 50 }), cadenceId);
const info = (win: Page, cadenceId: string) =>
  win.evaluate((id) => (globalThis as unknown as AppWindow).insectoids.webhooks.info(id), cadenceId);

let t: LaunchedApp;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  t = await launchApp({ env: { INSECTOIDS_WEBHOOK_PORT: '0' } });
  await expect
    .poll(() => t.win.evaluate(async () => (await (globalThis as unknown as AppWindow).insectoids.brainStatus()).state), { timeout: 30_000 })
    .toBe('ready');
  // No Scout survey before planning: the runs here only need the goal to start.
  await command(t.win, { type: 'setManagers', scoutBeforePlanning: false });
});

test.afterAll(async () => {
  await t?.close();
});

/** Makes a webhook cadence in the open project and waits until its URL answers. */
async function webhookCadence(win: Page, name: string, when: { type: 'webhook'; trust?: WebhookTrust }): Promise<string> {
  // Sent as the user's form would: without `trust` the hive fills in its default (the command type wants it filled).
  const create = {
    type: 'createCadence',
    cadence: { name, when, goal: 'Look at what the outside app sent and tidy up', budgetTokens: 50_000, autonomy: 'small-plans', enabled: true },
  } as Parameters<HiveApi['command']>[0];
  expect(await command(win, create)).toEqual({ ok: true });
  const c = (await snapshot(win)).cadences.find((x) => x.name === name)!;
  expect(c.when.type).toBe('webhook');
  expect(c.nextRunAt).toBeNull();
  await expect.poll(async () => (await info(win, c.id)).listening, { timeout: 10_000 }).toBe(true);
  return c.id;
}

/** The text main put on the clipboard (copySecret / newSecret never return the secret to the renderer). */
const clipboardText = (): Promise<string> => t.app.evaluate(({ clipboard }) => clipboard.readText());

async function copySecret(win: Page, cadenceId: string): Promise<string> {
  const r = await win.evaluate((id) => (globalThis as unknown as AppWindow).insectoids.webhooks.copySecret(id), cadenceId);
  expect(r.ok).toBe(true);
  const secret = await clipboardText();
  expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{20,}$/);
  // The reply to the renderer never carries the secret.
  expect(JSON.stringify(r)).not.toContain(secret);
  return secret;
}

type Via = 'signature' | 'github' | 'bearer' | 'none';
const sign = (body: string, secret: string): string => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/** POSTs `body` to the webhook URL from the test process, carrying `secret` the way `via` says. */
async function call(url: string, body: string, secret: string | null, via: Via = 'signature'): Promise<{ status: number; ok: boolean; message: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== null && via === 'signature') headers['x-insectoids-signature'] = sign(body, secret);
  if (secret !== null && via === 'github') headers['x-hub-signature-256'] = sign(body, secret);
  if (secret !== null && via === 'bearer') headers['authorization'] = `Bearer ${secret}`;
  const res = await fetch(url, { method: 'POST', headers, body });
  const json = (await res.json()) as { ok: boolean; message: string };
  expect(typeof json.message).toBe('string');
  if (secret) expect(json.message).not.toContain(secret);
  return { status: res.status, ok: json.ok, message: json.message };
}

const outcomes = async (win: Page, cadenceId: string): Promise<string[]> => (await runsOf(win, cadenceId)).map((r) => `${r.reason}:${r.outcome}`);

/** Ids of webhook approvals waiting right now. */
const waitingWebhookApprovals = async (win: Page): Promise<string[]> =>
  (await snapshot(win)).approvals.filter((a) => a.kind === 'webhook' && a.status === 'waiting').map((a) => a.id);

/** Waits for a webhook approval that wasn't in `before` and returns its id. */
async function newWebhookApproval(win: Page, before: string[]): Promise<string> {
  await expect.poll(async () => (await waitingWebhookApprovals(win)).filter((id) => !before.includes(id)).length, { timeout: 15_000 }).toBe(1);
  return (await waitingWebhookApprovals(win)).find((id) => !before.includes(id))!;
}

const DEFAULT_NAME = 'Deploy hook';
const STRICT_NAME = 'Strict hook';
const ALLOW_NAME = 'Open hook';
let defaultId = '';
let defaultSecret = '';
let strictId = '';

test('default trust: a note is saved, a run call waits in Approvals and starts the run once approved', async () => {
  test.setTimeout(90_000);
  const { win } = t;
  test.skip(await noKeyStoreOnLinux(win), NO_KEY_STORE);
  defaultId = await webhookCadence(win, DEFAULT_NAME, { type: 'webhook' });
  expect((await snapshot(win)).cadences.find((x) => x.id === defaultId)!.when).toEqual({ type: 'webhook', trust: 'communication-only' });

  const before = await info(win, defaultId);
  expect(before.vaultAvailable).toBe(true);
  expect(before.runUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/hooks/${defaultId}$`));
  expect(before.noteUrl).toBe(`${before.runUrl}/note`);
  defaultSecret = await copySecret(win, defaultId);
  const after = await info(win, defaultId);
  expect(after.hasSecret).toBe(true);
  expect(after.secretHint ?? '').toContain(defaultSecret.slice(-4));

  // Asking to run: accepted, logged as waiting, and a webhook approval waits for the user.
  const approvalsBefore = await waitingWebhookApprovals(win);
  const runBody = JSON.stringify({ event: 'build-finished', ref: 'main' });
  const run = await call(after.runUrl, runBody, defaultSecret);
  expect(run.status).toBe(202);
  expect(run.ok).toBe(true);
  await expect.poll(() => outcomes(win, defaultId), { timeout: 15_000 }).toContain('webhook:waiting');
  const approvalId = await newWebhookApproval(win, approvalsBefore);
  expect((await snapshot(win)).goals.filter((g) => g.cadenceId === defaultId)).toHaveLength(0);

  // Approving it starts a goal for this cadence, with what the sender sent attached.
  expect(await command(win, { type: 'approve', approvalId })).toEqual({ ok: true });
  await expect.poll(() => outcomes(win, defaultId), { timeout: 20_000 }).toContain('webhook:started');
  const started = (await runsOf(win, defaultId)).find((r) => r.outcome === 'started')!;
  expect(started.goalId).not.toBeNull();
  const goal = (await snapshot(win)).goals.find((g) => g.id === started.goalId)!;
  expect(goal.cadenceId).toBe(defaultId);
  expect(goal.text).toContain('build-finished');

  // A note only tells the hive something: saved straight away, nothing waits.
  const approvalsNow = await waitingWebhookApprovals(win);
  const note = await call(after.noteUrl, JSON.stringify({ note: 'The staging server was restarted.' }), defaultSecret);
  expect(note.status).toBe(200);
  expect(note.ok).toBe(true);
  await expect.poll(() => outcomes(win, defaultId), { timeout: 15_000 }).toContain('webhook:noted');
  expect(await waitingWebhookApprovals(win)).toEqual(approvalsNow);
});

test('a wrong or missing secret is refused (and logged); an unknown webhook is not found', async () => {
  const { win } = t;
  test.skip(await noKeyStoreOnLinux(win), NO_KEY_STORE);
  const { runUrl, noteUrl } = await info(win, defaultId);
  const body = JSON.stringify({ event: 'build-finished' });

  const bad = await call(runUrl, body, 'whsec_not-the-right-secret-at-all-0000000000000');
  expect(bad.status).toBe(401);
  expect(bad.ok).toBe(false);
  // Refusals are logged (at most once a minute per webhook, so only one here).
  await expect.poll(() => outcomes(win, defaultId), { timeout: 15_000 }).toContain('webhook:refused');
  const refused = (await runsOf(win, defaultId)).find((r) => r.outcome === 'refused')!;
  expect(refused.goalId).toBeNull();
  expect(refused.message).not.toContain(defaultSecret);

  const missing = await call(noteUrl, body, null, 'none');
  expect(missing.status).toBe(401);
  expect(missing.ok).toBe(false);

  // A bearer token that isn't the secret is refused too.
  expect((await call(noteUrl, body, 'whsec_wrong', 'bearer')).status).toBe(401);

  const unknown = await call(`${new URL(runUrl).origin}/hooks/no-such-cadence`, body, defaultSecret);
  expect(unknown.status).toBe(404);
  expect(unknown.ok).toBe(false);
});

test('a new secret replaces the old one at once', async () => {
  const { win } = t;
  test.skip(await noKeyStoreOnLinux(win), NO_KEY_STORE);
  const r = await win.evaluate((id) => (globalThis as unknown as AppWindow).insectoids.webhooks.newSecret(id), defaultId);
  expect(r.ok).toBe(true);
  const fresh = await clipboardText();
  expect(fresh).toMatch(/^whsec_/);
  expect(fresh).not.toBe(defaultSecret);
  expect(JSON.stringify(r)).not.toContain(fresh);

  const { noteUrl } = await info(win, defaultId);
  const notedBefore = (await runsOf(win, defaultId)).filter((x) => x.outcome === 'noted').length;
  expect((await call(noteUrl, JSON.stringify({ note: 'old secret' }), defaultSecret)).status).toBe(401);
  const ok = await call(noteUrl, JSON.stringify({ note: 'new secret' }), fresh);
  expect(ok.status).toBe(200);
  expect(ok.ok).toBe(true);
  await expect
    .poll(async () => (await runsOf(win, defaultId)).filter((x) => x.outcome === 'noted').length, { timeout: 15_000 })
    .toBe(notedBefore + 1);
  defaultSecret = fresh;
});

test('strict trust: even a note waits in Approvals, and saying no logs it as declined', async () => {
  const { win } = t;
  test.skip(await noKeyStoreOnLinux(win), NO_KEY_STORE);
  strictId = await webhookCadence(win, STRICT_NAME, { type: 'webhook', trust: 'strict' });
  const secret = await copySecret(win, strictId);
  const { noteUrl } = await info(win, strictId);

  const approvalsBefore = await waitingWebhookApprovals(win);
  const note = await call(noteUrl, 'The nightly backup finished.', secret, 'bearer');
  expect(note.status).toBe(202);
  expect(note.ok).toBe(true);
  await expect.poll(() => outcomes(win, strictId), { timeout: 15_000 }).toContain('webhook:waiting');
  const approvalId = await newWebhookApproval(win, approvalsBefore);

  expect(await command(win, { type: 'deny', approvalId })).toEqual({ ok: true });
  await expect.poll(() => outcomes(win, strictId), { timeout: 15_000 }).toContain('webhook:declined');
  expect(await outcomes(win, strictId)).not.toContain('webhook:noted');
  expect((await snapshot(win)).goals.filter((g) => g.cadenceId === strictId)).toHaveLength(0);
});

test('allow-all trust: a signed run call starts the run without asking', async () => {
  const { win } = t;
  test.skip(await noKeyStoreOnLinux(win), NO_KEY_STORE);
  const id = await webhookCadence(win, ALLOW_NAME, { type: 'webhook', trust: 'allow-all' });
  const secret = await copySecret(win, id);
  const { runUrl } = await info(win, id);

  const approvalsBefore = await waitingWebhookApprovals(win);
  // GitHub's header works the same as ours.
  const run = await call(runUrl, JSON.stringify({ action: 'opened', number: 7 }), secret, 'github');
  expect(run.status).toBe(200);
  expect(run.ok).toBe(true);
  await expect.poll(() => outcomes(win, id), { timeout: 20_000 }).toEqual(['webhook:started']);
  const [started] = await runsOf(win, id);
  const goal = (await snapshot(win)).goals.find((g) => g.id === started!.goalId)!;
  expect(goal.cadenceId).toBe(id);
  // No webhook approval was raised for it.
  expect(await waitingWebhookApprovals(win)).toEqual(approvalsBefore);
});

test('the Cadence screen shows the webhook URL, copies the secret, and words the run history', async () => {
  const { win } = t;
  test.skip(await noKeyStoreOnLinux(win), NO_KEY_STORE);
  // A strict webhook with one call waiting and one refused, so both show in its history.
  const { runUrl, noteUrl } = await info(win, strictId);
  expect((await call(noteUrl, 'Disk is nearly full.', 'whsec_wrong-secret-for-the-strict-hook-000000000')).status).toBe(401);
  const secret = await copySecret(win, strictId);
  expect((await call(noteUrl, 'Disk is nearly full.', secret)).status).toBe(202);
  await expect.poll(() => outcomes(win, strictId), { timeout: 15_000 }).toEqual(expect.arrayContaining(['webhook:refused', 'webhook:waiting']));

  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Cadence' }).click();
  await expect(win.getByRole('heading', { level: 1, name: 'Cadence' })).toBeVisible();
  const row = win.getByTestId('cadence-row').filter({ hasText: STRICT_NAME });
  await expect(row).toBeVisible();

  // The webhook panel shows beside the cadence's run history, opened with its "Runs" button.
  await row.getByRole('button', { name: 'Runs' }).click();
  const panel = win.getByTestId('webhook-panel');
  await expect(panel).toBeVisible();
  // The run URL is shown as text.
  await expect(panel.getByTestId('webhook-run-url')).toContainText('127.0.0.1');
  await expect(panel.getByTestId('webhook-run-url')).toContainText(runUrl);
  // The secret itself is never on screen.
  await expect(win.getByText(secret)).toHaveCount(0);

  // "Copy secret" puts it on the clipboard (in main), never on screen.
  await t.app.evaluate(({ clipboard }) => clipboard.writeText(''));
  await panel.getByRole('button', { name: 'Copy secret' }).click();
  await expect.poll(clipboardText, { timeout: 5_000 }).toBe(secret);

  const history = win.getByTestId('cadence-history');
  await expect(history.locator('[data-outcome="refused"]').first()).toBeVisible();
  await expect(history.locator('[data-outcome="waiting"]').first()).toBeVisible();
  // Outcomes in words (OUTCOME labels in cadence-words.ts), not colour alone.
  await expect(history.getByTestId('cadence-run').filter({ hasText: 'Refused' }).first()).toBeVisible();
  await expect(history.getByTestId('cadence-run').filter({ hasText: 'Waiting for you' }).first()).toBeVisible();
  // The reason reads "Webhook call".
  await expect(history.getByTestId('cadence-run').first()).toContainText(/webhook/i);
});

