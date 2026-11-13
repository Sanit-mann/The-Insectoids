import { expect, test } from '@playwright/test';
import type { HiveApi, HiveSnapshot } from '@insectoids/shared';
import { type LaunchedApp, launchApp } from './support/launch';

/**
 * The living hive (App 07; Phase 2 C4): every agent is a cell in a honeycomb with its status in words.
 * Arrow keys move between cells and Enter shows that agent's output. The motion pauses when the view
 * isn't showing and is off under reduced motion.
 */
type Win = { insectoids: { hive: HiveApi; brainStatus(): Promise<{ state: string }> } };
let t: LaunchedApp;

const snapshot = (): Promise<HiveSnapshot> => t.win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.snapshot());

test.beforeAll(async () => {
  t = await launchApp();
  await expect
    .poll(() => t.win.evaluate(async () => (await (globalThis as unknown as Win).insectoids.brainStatus()).state), { timeout: 30_000 })
    .toBe('ready');
  await t.win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.command({ type: 'setManagers', scoutBeforePlanning: false }));
  expect(await t.win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.command({ type: 'submitGoal', text: 'Say hello' }))).toEqual({ ok: true });
  // "Say hello" plans two waves, so the plan waits for approval (Hive 02-D11): approve it, then let the
  // Inspector finish the first wave.
  await expect
    .poll(
      async () =>
        t.win.evaluate(async () => {
          const hive = (globalThis as unknown as Win).insectoids.hive;
          const s = await hive.snapshot();
          const plan = s.approvals.find((a) => a.kind === 'plan' && a.status === 'waiting');
          if (plan) await hive.command({ type: 'approve', approvalId: plan.id });
          return s.agents.some((a) => a.role === 'inspector');
        }),
      { timeout: 60_000 },
    )
    .toBe(true);
});

test.afterAll(async () => {
  await t?.close();
});

test('every agent is a cell with its status in words, and the keyboard walks the comb', async () => {
  const { win } = t;
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Hive' }).click();
  await win.getByTestId('hive-view-living').click();
  const hive = win.getByTestId('living-hive');
  await expect(hive).toBeVisible();
  await expect(hive).toHaveAttribute('data-animating', 'true');

  const cells = hive.getByTestId('hive-cell');
  await expect.poll(() => cells.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  const roles = await cells.evaluateAll((els) => els.map((el) => el.getAttribute('data-role')));
  expect(roles).toContain('queen');
  expect(roles).toContain('inspector');
  expect(roles.some((r) => r === 'coder' || r === 'tester')).toBe(true);

  // Status is written in every cell (never colour alone), and named in its label.
  const s = await snapshot();
  const first = cells.first();
  const run = await first.getAttribute('data-run');
  const agent = s.agents.find((a) => a.runId === run)!;
  const words = { working: 'Working', waiting: 'Waiting', blocked: 'Blocked', done: 'Done', paused: 'Paused', idle: 'Idle', failed: 'Failed' }[agent.status];
  await expect(first).toContainText(words);
  await expect(first).toHaveAttribute('aria-label', new RegExp(words));

  // Arrow keys move focus between cells; Enter shows that agent beside the comb.
  await first.focus();
  await win.keyboard.press('ArrowRight');
  const second = cells.nth(1);
  await expect(second).toBeFocused();
  await win.keyboard.press('Enter');
  await expect(second).toHaveAttribute('aria-pressed', 'true');
  const secondRun = await second.getAttribute('data-run');
  const secondAgent = s.agents.find((a) => a.runId === secondRun)!;
  const panel = win.getByRole('complementary', { name: 'Selected agent' }).filter({ visible: true });
  await expect(panel).toContainText(secondAgent.title);
  await win.keyboard.press('ArrowLeft');
  await expect(first).toBeFocused();
});

test('the motion pauses when the view is hidden and stays off under reduced motion', async () => {
  const { win } = t;
  const hive = win.getByTestId('living-hive');
  // Stand alone: open the Hive screen here too (a retry starts from a fresh app on the Queen screen).
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Hive' }).click();
  await win.getByTestId('hive-view-living').click();
  await expect(hive).toHaveAttribute('data-animating', 'true');

  // Lanes showing: the comb is hidden, so it doesn't animate.
  await win.getByTestId('hive-view-lanes').click();
  await expect(hive).toHaveAttribute('data-animating', 'false');
  await win.getByTestId('hive-view-living').click();
  await expect(hive).toHaveAttribute('data-animating', 'true');

  // The user's system asks for reduced motion: none at all.
  await win.emulateMedia({ reducedMotion: 'reduce' });
  await expect(hive).toHaveAttribute('data-animating', 'false');
  await win.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(hive).toHaveAttribute('data-animating', 'true');
});
