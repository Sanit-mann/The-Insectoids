import { type Page, expect, test } from '@playwright/test';
import type { HiveApi } from '@insectoids/shared';
import { holdUntilDone } from './support/hold';
import { type LaunchedApp, launchApp } from './support/launch';

/**
 * Cadence screen (Phase 3 A1): create, list, switch off and on, run now, history, edit, delete; and a
 * schedule that fires on its own. The fake engine's Queen plans "Say hello" in two waves, so a run's plan
 * waits for approval at the default autonomy ("small plans run"), which is enough to see the goal start.
 */
type Win = { insectoids: { hive: HiveApi; brainStatus(): Promise<{ state: string }> } };
const hive = (win: Page) => ({
  snapshot: () => win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.snapshot()),
});

async function ready(win: Page): Promise<void> {
  await expect
    .poll(() => win.evaluate(async () => (await (globalThis as unknown as Win).insectoids.brainStatus()).state), { timeout: 30_000 })
    .toBe('ready');
  // No Scout survey before planning: the runs here only need the goal to start.
  await win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.command({ type: 'setManagers', scoutBeforePlanning: false }));
}

async function openCadence(win: Page): Promise<void> {
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Cadence' }).click();
  await expect(win.getByRole('heading', { level: 1, name: 'Cadence' })).toBeVisible();
}

test.describe('the Cadence screen', () => {
  test.describe.configure({ mode: 'serial' });
  let t: LaunchedApp;

  test.beforeAll(async () => {
    t = await launchApp();
    await ready(t.win);
  });

  test.afterAll(async () => {
    await t?.close();
  });

  test('explains what a cadence is when there is none', async () => {
    const { win } = t;
    await openCadence(win);
    const empty = win.getByTestId('cadence-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('when');
    await expect(empty).toContainText('goes through the Queen');
  });

  test('the form explains problems in words and sends nothing until they are fixed', async () => {
    const { win } = t;
    await win.getByTestId('cadence-empty').getByRole('button', { name: 'New cadence' }).click();
    const form = win.getByTestId('cadence-form');
    await expect(form).toBeVisible();
    await form.getByLabel('Every', { exact: true }).fill('5');
    await form.getByLabel('Unit').selectOption('minutes');
    await form.getByRole('button', { name: 'Create cadence' }).click();
    const alert = form.getByRole('alert').or(form.getByRole('status')).filter({ hasText: 'Check the form' });
    await expect(alert).toContainText('Give the cadence a name.');
    await expect(alert).toContainText('the shortest interval is 15 minutes');
    await expect(alert).toContainText('Tell the Queen what to do');
    expect((await hive(win).snapshot()).cadences).toHaveLength(0);
  });

  test('creates an interval cadence and lists it with its schedule and next run in words', async () => {
    const { win } = t;
    const form = win.getByTestId('cadence-form');
    await form.getByLabel('Name').fill('Weekly report');
    await form.getByLabel('Every', { exact: true }).fill('15');
    await form.getByLabel('What the Queen should do each time').fill('Say hello');
    await form.getByRole('button', { name: 'Create cadence' }).click();
    await expect(form).toHaveCount(0);

    const row = win.getByTestId('cadence-row').filter({ hasText: 'Weekly report' });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('cadence-when')).toContainText(/15 min/i);
    await expect(row.getByTestId('cadence-next')).toHaveText(/^next: .+, in 1[45] min$/);
    await expect(row.getByTestId('cadence-autonomy')).toHaveText('Small plans start on their own');
    await expect(row.getByTestId('cadence-last-run')).toHaveText('Not run yet');
    const [c] = (await hive(win).snapshot()).cadences;
    expect(c).toMatchObject({ name: 'Weekly report', when: { type: 'interval', everyMinutes: 15 }, autonomy: 'small-plans', enabled: true });
  });

  test('switches it off and on', async () => {
    const { win } = t;
    const row = win.getByTestId('cadence-row').filter({ hasText: 'Weekly report' });
    const toggle = row.getByRole('switch', { name: 'Run "Weekly report" on its schedule' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(row.getByTestId('cadence-next')).toHaveText('Off');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(row.getByTestId('cadence-next')).toHaveText(/^next: /);
  });

  test('Run now starts a goal marked with the cadence, and the history says so', async () => {
    test.setTimeout(60_000);
    const { win } = t;
    const row = win.getByTestId('cadence-row').filter({ hasText: 'Weekly report' });
    await row.getByRole('button', { name: 'Run now' }).click();

    await expect.poll(async () => (await hive(win).snapshot()).goals.filter((g) => g.cadenceId !== null).length, { timeout: 20_000 }).toBe(1);
    await expect(row.getByTestId('cadence-last-run')).toContainText('Started', { timeout: 10_000 });

    await row.getByRole('button', { name: 'Runs' }).click();
    const history = win.getByTestId('cadence-history');
    const run = history.getByTestId('cadence-run').first();
    await expect(run).toHaveAttribute('data-outcome', 'started');
    await expect(run).toContainText('Started');
    await expect(run).toContainText('Run now');

    // The goal link opens the Queen screen, where the goal carries the cadence's name.
    await run.getByRole('button', { name: 'Open the goal' }).click();
    await expect(win.getByRole('heading', { level: 1, name: 'Queen' })).toBeVisible();
    await expect(win.getByTestId('from-cadence').first()).toContainText('From cadence: Weekly report');

    // So does the Taskboard.
    await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Taskboard' }).click();
    await expect(win.getByTestId('from-cadence').first()).toContainText('Weekly report');
  });

  test('edits it to a weekly schedule', async () => {
    const { win } = t;
    await openCadence(win);
    const row = win.getByTestId('cadence-row').filter({ hasText: 'Weekly report' });
    await row.getByRole('button', { name: 'Edit' }).click();
    const form = win.getByTestId('cadence-form');
    await expect(form.getByRole('heading', { name: 'Edit "Weekly report"' })).toBeVisible();
    await form.getByRole('radio', { name: 'On days of the week' }).click();
    // Monday is chosen by default; add Thursday.
    await expect(form.getByRole('button', { name: 'Monday' })).toHaveAttribute('aria-pressed', 'true');
    await form.getByRole('button', { name: 'Thursday' }).click();
    await form.getByLabel('Time (your local time)').fill('09:00');
    await form.getByRole('radio', { name: /Ask me/ }).click();
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toHaveCount(0);

    await expect(row.getByTestId('cadence-when')).toContainText(/Mon/);
    await expect(row.getByTestId('cadence-when')).toContainText(/Thu/);
    await expect(row.getByTestId('cadence-when')).toContainText('09:00');
    await expect(row.getByTestId('cadence-next')).toHaveText(/^next: .*09:00, in \d+ (min|hours?|days)$/);
    await expect(row.getByTestId('cadence-autonomy')).toHaveText('Asks you to approve every plan');
    const [c] = (await hive(win).snapshot()).cadences;
    expect(c?.when).toEqual({ type: 'weekly', days: [1, 4], time: '09:00' });
  });

  test('hold to delete removes it; the empty state comes back', async () => {
    const { win } = t;
    const row = win.getByTestId('cadence-row').filter({ hasText: 'Weekly report' });
    await row.getByRole('button', { name: 'Edit' }).click();
    const form = win.getByTestId('cadence-form');
    await expect(form).toContainText('Its run history stays in the Brain.');
    await holdUntilDone(win, form.getByRole('button', { name: 'Hold to delete Weekly report' }));
    await expect(win.getByTestId('cadence-row')).toHaveCount(0);
    await expect(win.getByTestId('cadence-empty')).toBeVisible();
    expect((await hive(win).snapshot()).cadences).toHaveLength(0);
  });
});

test('a cadence fires on its own when it is due', async () => {
  test.setTimeout(90_000);
  // Under e2e, INSECTOIDS_E2E_CADENCE_SECONDS makes interval minutes count as seconds: 15 means 15 s.
  const t = await launchApp({ env: { INSECTOIDS_E2E_CADENCE_SECONDS: '1' } });
  try {
    const { win } = t;
    await ready(win);
    const created = await win.evaluate(() =>
      (globalThis as unknown as Win).insectoids.hive.command({
        type: 'createCadence',
        cadence: { name: 'Quick check', when: { type: 'interval', everyMinutes: 15 }, goal: 'Say hello', budgetTokens: 150_000, autonomy: 'small-plans', enabled: true },
      }),
    );
    expect(created).toEqual({ ok: true });
    await openCadence(win);
    const row = win.getByTestId('cadence-row').filter({ hasText: 'Quick check' });
    await expect(row).toBeVisible();

    await expect
      .poll(
        async () => {
          const c = (await hive(win).snapshot()).cadences.find((x) => x.name === 'Quick check');
          return c?.lastRun ? `${c.lastRun.reason}:${c.lastRun.outcome}` : null;
        },
        { timeout: 40_000, intervals: [1000] },
      )
      .toBe('schedule:started');
    const s = await hive(win).snapshot();
    const c = s.cadences.find((x) => x.name === 'Quick check')!;
    expect(s.goals.some((g) => g.cadenceId === c.id)).toBe(true);
    await expect(row.getByTestId('cadence-last-run')).toContainText('Started');
  } finally {
    await t.close();
  }
});
