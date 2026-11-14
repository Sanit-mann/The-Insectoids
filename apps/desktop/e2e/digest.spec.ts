import { type Page, expect, test } from '@playwright/test';
import { type CadenceRunView, type HiveApi, MAINTENANCE_JOBS, maintenanceCadenceId } from '@insectoids/shared';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * "While you were away" (Phase 3 B1, Cadence 05-D8).
 *
 * Unattended work = cadence runs the user didn't start (schedule, catch-up, wake, file, event, webhook; never
 * `manual`) plus the built-in maintenance jobs. The digest covers what happened since the user last said "Got it"
 * (on a first start that moment is "now"). It opens by itself, when the window is visible, after a USER cadence ran
 * or a built-in job failed; routine `done` maintenance is listed but never opens it.
 *
 * "Overnight" here is the fast clock: INSECTOIDS_E2E_CADENCE_SECONDS=1 counts interval minutes as seconds, so a
 * 15-minute cadence fires after 15 s. The fake engine's Queen plans any goal in two waves, so a started run's plan
 * waits for approval at the default autonomy ("small plans run").
 *
 * Each test launches its own app, so every one starts with a clean digest.
 *
 * UI: the dialog (role dialog, name "While you were away", data-testid away-digest), its "Got it" and
 * "Later" buttons, the always-there opener `away-digest-button`, and inside the dialog `digest-headline`,
 * `digest-waiting`, `digest-cadence` (with data-cadence-id) and `digest-goal`.
 */
const FAST_CLOCK = { INSECTOIDS_E2E_CADENCE_SECONDS: '1' };

const snapshot = (win: Page) => win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.snapshot());
const digest = (win: Page) => win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.digest());
const command = (win: Page, cmd: Parameters<HiveApi['command']>[0]) =>
  win.evaluate((c) => (globalThis as unknown as AppWindow).insectoids.hive.command(c), cmd);
const runsOf = (win: Page, cadenceId: string): Promise<CadenceRunView[]> =>
  win.evaluate((id) => (globalThis as unknown as AppWindow).insectoids.hive.cadenceRuns({ cadenceId: id, limit: 50 }), cadenceId);

async function ready(win: Page): Promise<void> {
  await expect
    .poll(() => win.evaluate(async () => (await (globalThis as unknown as AppWindow).insectoids.brainStatus()).state), { timeout: 30_000 })
    .toBe('ready');
  // No Scout survey before planning: the runs here only need the goal to start.
  expect(await command(win, { type: 'setManagers', scoutBeforePlanning: false })).toEqual({ ok: true });
}

// the dialog by role and name; data-testid="away-digest" is the same element.
const dialogOf = (win: Page) => win.getByRole('dialog', { name: 'While you were away' });

/** The user steps away and comes back: the window is hidden, then shown and focused again. */
async function awayAndBack(t: LaunchedApp): Promise<void> {
  await t.app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
    if (!w) throw new Error('no app window');
    w.hide();
    await new Promise((r) => setTimeout(r, 500));
    w.show();
    w.focus();
  });
  await expect.poll(() => t.win.evaluate(() => (globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState)).toBe('visible');
}

/** Waits a moment, so a dialog that would open by itself has had the chance, then checks it didn't. */
async function expectNoDialog(win: Page): Promise<void> {
  await win.waitForTimeout(2_500);
  await expect(dialogOf(win)).not.toBeVisible();
}

/** Makes a user cadence every 15 "minutes" (15 s on the fast clock) that asks the Queen to "Say hello". */
async function overnightCadence(win: Page, name: string, everyMinutes = 15): Promise<string> {
  const made = await command(win, {
    type: 'createCadence',
    cadence: { name, when: { type: 'interval', everyMinutes }, goal: 'Say hello', budgetTokens: 150_000, autonomy: 'small-plans', enabled: true },
  });
  expect(made).toEqual({ ok: true });
  const c = (await snapshot(win)).cadences.find((x) => x.name === name);
  expect(c, name).toBeDefined();
  return c!.id;
}

/**
 * Waits until the cadence started a goal on its own (any reason but `manual`), then switches it off so no further
 * runs change the counts while the test reads them. Returns the started run.
 */
async function waitForUnattendedStart(win: Page, cadenceId: string): Promise<CadenceRunView> {
  await expect
    .poll(async () => (await runsOf(win, cadenceId)).some((r) => r.reason !== 'manual' && r.outcome === 'started'), { timeout: 40_000, intervals: [1_000] })
    .toBe(true);
  expect(await command(win, { type: 'setCadenceEnabled', id: cadenceId, enabled: false })).toEqual({ ok: true });
  return (await runsOf(win, cadenceId)).find((r) => r.reason !== 'manual' && r.outcome === 'started')!;
}

/** The headline as the dialog shows it: the snapshot's line, perhaps without the "While you were away:" lead. */
const headlineBody = (headline: string): string => headline.replace(/^while you were away:\s*/i, '').trim();

test('a fresh start has nothing unseen, and the digest does not open', async () => {
  test.setTimeout(60_000);
  const t = await launchApp({ env: FAST_CLOCK });
  try {
    const { win } = t;
    await ready(win);
    const started = Date.now();

    const badge = (await snapshot(win)).digest;
    expect(badge.unseen).toBe(false);
    expect(badge.headline).toBeNull();
    // The first start is "now": old history never shows.
    expect(badge.since).toBeGreaterThan(started - 120_000);

    const d = await digest(win);
    expect(d.unseen).toBe(false);
    expect(d.headline).toBeNull();
    expect(d.totals.runs).toBe(0);
    expect(d.cadences.filter((c) => !c.builtIn)).toHaveLength(0);

    await expectNoDialog(win);
    await awayAndBack(t);
    await expectNoDialog(win);
    expect((await snapshot(win)).digest.unseen).toBe(false);
  } finally {
    await t.close();
  }
});

test('overnight: a cadence that ran on its own makes the digest unseen; it opens on return and "Got it" marks it read', async () => {
  test.setTimeout(90_000);
  const t = await launchApp({ env: FAST_CLOCK });
  try {
    const { win } = t;
    await ready(win);
    const id = await overnightCadence(win, 'Overnight check');
    const run = await waitForUnattendedStart(win, id);
    expect(run.goalId).not.toBeNull();
    const goalId = run.goalId!;

    // The fake Queen's two-wave plan waits for the user's yes.
    await expect.poll(async () => (await snapshot(win)).goals.find((g) => g.id === goalId)?.status, { timeout: 30_000 }).toBe('awaiting_approval');

    await expect.poll(async () => (await snapshot(win)).digest.unseen, { timeout: 15_000 }).toBe(true);
    const badge = (await snapshot(win)).digest;
    expect(badge.headline).toEqual(expect.any(String));
    expect(badge.headline!.length).toBeGreaterThan(0);

    // The full digest: this cadence first (user cadences before built-in jobs), with its goal, counts and spend.
    await expect.poll(async () => (await digest(win)).cadences.find((c) => c.cadenceId === id)?.goals[0]?.waitingFor ?? null, { timeout: 15_000 }).toBe('plan');
    const d = await digest(win);
    expect(d.unseen).toBe(true);
    expect(d.headline).toEqual(expect.any(String));
    expect(d.until).toBeGreaterThanOrEqual(d.since);
    expect(d.cadences[0]?.cadenceId).toBe(id);
    const c = d.cadences.find((x) => x.cadenceId === id)!;
    expect(c).toMatchObject({ name: 'Overnight check', builtIn: false });
    expect(c.outcomes['started'] ?? 0).toBeGreaterThanOrEqual(1);
    const g = c.goals.find((x) => x.goalId === goalId);
    expect(g, 'the started goal is listed').toBeDefined();
    expect(g!.status).toBe('awaiting_approval');
    expect(g!.outcome.length).toBeGreaterThan(0);
    expect(g!.waitingFor).toBe('plan');
    expect(g!.spentTokens).toBeGreaterThanOrEqual(0);
    expect(g!.spentUsd).toBeGreaterThanOrEqual(0);
    expect(d.totals.runs).toBeGreaterThanOrEqual(1);
    expect(d.totals.goalsOpen).toBeGreaterThanOrEqual(1);
    expect(d.totals.tokens).toBeGreaterThanOrEqual(0);
    expect(d.totals.costUsd).toBeGreaterThanOrEqual(0);
    // What waits for the user now includes this goal's plan.
    expect(d.waiting.total).toBeGreaterThanOrEqual(1);
    expect(d.waiting.byKind['plan'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(d.waiting.items.some((a) => a.kind === 'plan' && a.goalId === goalId && a.status === 'waiting')).toBe(true);
    // While the user is in the app, unattended work only shows as the top-bar dot: the dialog never pops up mid-use.
    await expectNoDialog(win);
    await expect(win.getByTestId('away-digest-button')).toHaveAttribute('data-unseen', 'true');
    // The user comes back to the window (shown from the tray): now it opens by itself.
    await awayAndBack(t);
    const dialog = dialogOf(win);
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(win.getByTestId('away-digest')).toBeVisible();
    const headline = dialog.getByTestId('digest-headline');
    await expect
      .poll(async () => {
        const shown = (await headline.textContent()) ?? '';
        const now = (await snapshot(win)).digest.headline ?? '';
        return now.length > 0 && shown.includes(headlineBody(now));
      }, { timeout: 10_000 })
      .toBe(true);
    const block = dialog.locator(`[data-testid="digest-cadence"][data-cadence-id="${id}"]`);
    await expect(block).toBeVisible();
    await expect(block).toContainText('Overnight check');
    await expect(block.getByTestId('digest-goal').first()).toBeVisible();
    await expect(dialog.getByTestId('digest-waiting')).toBeVisible();

    // "Got it": it closes and nothing is unseen any more.
    await dialog.getByRole('button', { name: 'Got it', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(async () => (await snapshot(win)).digest.unseen, { timeout: 10_000 }).toBe(false);
    expect((await digest(win)).unseen).toBe(false);

    // Coming back again doesn't open it a second time.
    await awayAndBack(t);
    await expectNoDialog(win);
  } finally {
    await t.close();
  }
});

test('a cadence the user runs with "Run now" does not make the digest unseen', async () => {
  test.setTimeout(60_000);
  // No fast clock: the 15-minute schedule can't fire during the test, so only the manual run happens.
  const t = await launchApp();
  try {
    const { win } = t;
    await ready(win);
    const id = await overnightCadence(win, 'Manual check');
    expect(await command(win, { type: 'runCadenceNow', id })).toEqual({ ok: true });
    await expect
      .poll(async () => (await runsOf(win, id)).map((r) => `${r.reason}:${r.outcome}`), { timeout: 20_000 })
      .toContain('manual:started');
    const goalId = (await runsOf(win, id)).find((r) => r.outcome === 'started')!.goalId!;
    await expect
      .poll(async () => (await snapshot(win)).goals.find((g) => g.id === goalId)?.status, { timeout: 30_000 })
      .toMatch(/^(awaiting_approval|running|stuck|done)$/);

    // Give the host a moment to update the badge, should it (wrongly) count the run.
    await win.waitForTimeout(3_000);
    expect((await snapshot(win)).digest.unseen).toBe(false);
    const d = await digest(win);
    expect(d.unseen).toBe(false);
    expect(d.totals.runs).toBe(0);
    expect(d.cadences.find((c) => c.cadenceId === id)).toBeUndefined();

    await expectNoDialog(win);
    await awayAndBack(t);
    await expectNoDialog(win);
  } finally {
    await t.close();
  }
});

test('routine housekeeping that ran on its own is listed but does not open the digest', async () => {
  test.setTimeout(90_000);
  const t = await launchApp({ env: FAST_CLOCK });
  try {
    const { win } = t;
    await ready(win);
    // The Brain health check every 15 "minutes" (15 s on the fast clock): it then runs on schedule during the test.
    const job = 'brain-audit' as const;
    const id = maintenanceCadenceId(job);
    await expect.poll(async () => (await snapshot(win)).cadences.some((c) => c.id === id), { timeout: 15_000 }).toBe(true);
    const audit = (await snapshot(win)).cadences.find((c) => c.id === id)!;
    const updated = await command(win, {
      type: 'updateCadence',
      id,
      cadence: {
        name: audit.name,
        // Built-in jobs have no goal of their own; the command's schema still wants one (as in maintenance.spec.ts).
        goal: audit.goal.trim().length >= 3 ? audit.goal : MAINTENANCE_JOBS[job].sentence,
        budgetTokens: audit.budgetTokens,
        autonomy: audit.autonomy,
        enabled: true,
        when: { type: 'maintenance', job, schedule: { type: 'interval', everyMinutes: 15 } },
      },
    });
    expect(updated).toEqual({ ok: true });

    // It runs on its own (schedule, or catch-up if it counts as overdue) and finishes as routine `done`.
    await expect
      .poll(async () => (await runsOf(win, id)).some((r) => r.reason !== 'manual' && r.outcome === 'done'), { timeout: 45_000, intervals: [1_000] })
      .toBe(true);
    await win.waitForTimeout(2_000);

    expect((await snapshot(win)).digest.unseen).toBe(false);
    const d = await digest(win);
    expect(d.unseen).toBe(false);
    const listed = d.cadences.find((c) => c.cadenceId === id);
    expect(listed, 'the job is listed').toBeDefined();
    expect(listed!.builtIn).toBe(true);
    expect(listed!.outcomes['done'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(listed!.goals).toHaveLength(0);
    expect(d.totals.jobs).toBeGreaterThanOrEqual(1);
    expect(d.totals.runs).toBe(0);

    await expectNoDialog(win);
    await awayAndBack(t);
    await expectNoDialog(win);
    // Opened by hand it lists the job; with nothing unread it offers Close, not Later, and stays read.
    // Opened by hand it lists the job; "Later" leaves it as it was.
    await win.getByTestId('away-digest-button').click();
    const dialog = dialogOf(win);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(`[data-testid="digest-cadence"][data-cadence-id="${id}"]`)).toContainText(MAINTENANCE_JOBS[job].name);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect((await snapshot(win)).digest.unseen).toBe(false);
  } finally {
    await t.close();
  }
});

test('"Later" closes the digest without marking it read; the button opens it again', async () => {
  test.setTimeout(90_000);
  const t = await launchApp({ env: FAST_CLOCK });
  try {
    const { win } = t;
    await ready(win);
    const id = await overnightCadence(win, 'Later check');
    await waitForUnattendedStart(win, id);
    await expect.poll(async () => (await snapshot(win)).digest.unseen, { timeout: 20_000 }).toBe(true);

    await awayAndBack(t);
    const dialog = dialogOf(win);
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    await dialog.getByRole('button', { name: 'Later', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    // Still unseen: "Later" is not "Got it".
    await win.waitForTimeout(1_000);
    expect((await snapshot(win)).digest.unseen).toBe(true);
    expect((await digest(win)).unseen).toBe(true);

    // The button opens it any time, with the same cadence in it.
    const opener = win.getByTestId('away-digest-button');
    await expect(opener).toHaveAccessibleName(/While you were away/);
    await opener.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(`[data-testid="digest-cadence"][data-cadence-id="${id}"]`)).toContainText('Later check');

    await dialog.getByRole('button', { name: 'Got it', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(async () => (await snapshot(win)).digest.unseen, { timeout: 10_000 }).toBe(false);
  } finally {
    await t.close();
  }
});
