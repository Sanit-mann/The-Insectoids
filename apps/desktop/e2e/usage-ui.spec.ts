import { expect, test } from '@playwright/test';
import type { HiveApi, HiveSnapshot } from '@insectoids/shared';
import { type LaunchedApp, launchApp } from './support/launch';

/**
 * Treasurer v2 in the UI (Phase 2 A5): usage meters and the user's limits on the engine card, the
 * "near / limit reached" warning in the side panel, and "Why this model" in the Hive monitor.
 * Driven by the scripted fake engine (no tokens are spent).
 */
let t: LaunchedApp;
/** The e2e tsconfig has no DOM types; this is `window` inside win.evaluate. */
type Win = { insectoids: { hive: HiveApi; brainStatus(): Promise<{ state: string }> } };

const snap = (): Promise<HiveSnapshot> => t.win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.snapshot());
const nav = (name: string) => t.win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true });

test.beforeAll(async () => {
  t = await launchApp();
  await expect
    .poll(() => t.win.evaluate(async () => (await (globalThis as unknown as Win).insectoids.brainStatus()).state), { timeout: 30_000 })
    .toBe('ready');

  // One goal through the fake engine, so there is usage to show.
  const submitted = await t.win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.command({ type: 'submitGoal', text: 'Say hello' }));
  expect(submitted).toEqual({ ok: true });
  let planId = '';
  await expect
    .poll(async () => (planId = (await snap()).approvals.find((a) => a.status === 'waiting' && a.kind === 'plan')?.id ?? ''), { timeout: 30_000 })
    .not.toBe('');
  await t.win.evaluate((id) => (globalThis as unknown as Win).insectoids.hive.command({ type: 'approve', approvalId: id }), planId);
  await expect.poll(async () => (await snap()).cards.filter((c) => c.status === 'done').length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
});

test.afterAll(async () => {
  await t?.close();
});

test('the engine card shows usage in rolling windows', async () => {
  await nav('Connections').click();
  const usage = t.win.getByTestId('engine-fake-usage');
  await expect(usage).toBeVisible();
  await expect(t.win.getByTestId('engine-fake-usage-5h')).toContainText(/[1-9]\d* runs?/);
  await expect(t.win.getByTestId('engine-fake-usage-7d')).toContainText('tokens');
  await expect(usage).toContainText("can't see");
  await expect(t.win.getByTestId('engine-fake-usage-state')).toHaveAttribute('data-state', 'ok');
});

test('a tiny 5-hour limit shows near or reached, and the side panel warns', async () => {
  await nav('Connections').click();
  const usage = t.win.getByTestId('engine-fake-usage');
  await usage.getByRole('button', { name: 'Set limits' }).click();
  await usage.getByLabel('US$ per 5 hours').fill('0.0001');
  await usage.getByRole('button', { name: 'Save limits' }).click();
  await expect(t.win.getByTestId('engine-fake-usage-state')).toHaveAttribute('data-state', /near|exhausted/, { timeout: 10_000 });
  await expect(t.win.getByTestId('engine-fake-usage-5h')).toContainText('limit');

  await nav('Queen').click();
  const warning = t.win.getByTestId('usage-warning');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(/Near a usage limit|Usage limit reached/);
  await warning.click();
  await expect(t.win.getByRole('heading', { level: 1, name: 'Connections' })).toBeVisible();
});

test('clearing the limits brings the engine back to ok', async () => {
  await nav('Connections').click();
  const usage = t.win.getByTestId('engine-fake-usage');
  await usage.getByRole('button', { name: 'Set limits' }).click();
  await usage.getByLabel('US$ per 5 hours').fill('');
  await usage.getByLabel('US$ per 7 days').fill('');
  await usage.getByRole('button', { name: 'Save limits' }).click();
  await expect(t.win.getByTestId('engine-fake-usage-state')).toHaveAttribute('data-state', 'ok', { timeout: 10_000 });

  await nav('Queen').click();
  await expect(t.win.getByTestId('usage-warning')).toHaveCount(0);
});

test('a bad limit is refused inline', async () => {
  await nav('Connections').click();
  const usage = t.win.getByTestId('engine-fake-usage');
  await usage.getByRole('button', { name: 'Set limits' }).click();
  await usage.getByLabel('US$ per 5 hours').fill('-3');
  await usage.getByRole('button', { name: 'Save limits' }).click();
  await expect(usage).toContainText('US dollars above 0');
  await usage.getByRole('button', { name: 'Cancel' }).click();
});

test('the Hive monitor says why each model was chosen', async () => {
  await nav('Hive').click();
  const withReason = (await snap()).agents.find((a) => a.routeReason);
  expect(withReason, 'some lane has a route reason').toBeTruthy();
  // Run ids contain "#", so select by attribute rather than a CSS #id.
  await t.win.locator(`[id="lane-${withReason!.runId}"]`).click();
  const reason = t.win.getByTestId('route-reason');
  await expect(reason).toContainText('Why this model');
  await expect(reason).toContainText(withReason!.routeReason!);
});
