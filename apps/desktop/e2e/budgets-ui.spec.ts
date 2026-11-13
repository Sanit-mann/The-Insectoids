import { expect, test } from '@playwright/test';
import type { HiveApi } from '@insectoids/shared';
import { type LaunchedApp, launchApp } from './support/launch';

/**
 * Budgets (Phase 2 C4): after a goal runs with the scripted engine, the screen shows what the goal used,
 * the last 14 days, spend by role, and every routing decision with the Treasurer's reason.
 */
type Win = { insectoids: { hive: HiveApi; brainStatus(): Promise<{ state: string }> } };
let t: LaunchedApp;

test.beforeAll(async () => {
  t = await launchApp();
  await expect
    .poll(() => t.win.evaluate(async () => (await (globalThis as unknown as Win).insectoids.brainStatus()).state), { timeout: 30_000 })
    .toBe('ready');
  await t.win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.command({ type: 'setManagers', scoutBeforePlanning: false }));
  expect(await t.win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.command({ type: 'submitGoal', text: 'Say hello' }))).toEqual({ ok: true });
  // Approve the two-wave plan, then wait until every card is done (the merge into main waits for the user).
  await expect
    .poll(
      async () =>
        t.win.evaluate(async () => {
          const hive = (globalThis as unknown as Win).insectoids.hive;
          const s = await hive.snapshot();
          const plan = s.approvals.find((a) => a.kind === 'plan' && a.status === 'waiting');
          if (plan) await hive.command({ type: 'approve', approvalId: plan.id });
          return s.cards.length > 0 && s.cards.every((c) => c.status === 'done');
        }),
      { timeout: 90_000 },
    )
    .toBe(true);
});

test.afterAll(async () => {
  await t?.close();
});

test('the Budgets screen shows the goal, the days, the roles, and every routing decision with its reason', async () => {
  test.setTimeout(90_000);
  const { win } = t;
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Budgets' }).click();
  await expect(win.getByRole('heading', { level: 1, name: 'Budgets' })).toBeVisible();
  const screen = win.getByTestId('budgets-screen');

  const goal = screen.getByTestId('budget-goal').filter({ hasText: 'Say hello' }).first();
  await expect(goal).toBeVisible({ timeout: 15_000 });
  await expect(goal).toContainText(/tokens/);

  const days = screen.getByTestId('budget-days');
  await expect(days.getByText('Tokens per day')).toBeVisible();
  await expect(days.getByText('Cost per day')).toBeVisible();
  // The table view carries the same numbers in text.
  await days.getByRole('button', { name: 'Show as table' }).click();
  await expect(days.getByRole('table')).toBeVisible();
  await days.getByRole('button', { name: 'Show charts' }).click();

  const roles = screen.getByTestId('budget-roles');
  await expect(roles.locator('[data-role="queen"]')).toBeVisible();
  await expect(roles).toContainText(/Coder|Tester/);

  const rows = screen.getByTestId('routing-row');
  await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(3);
  // Every decision says why, in words.
  const reasons = await rows.evaluateAll((els) => els.map((el) => el.children[4]?.textContent?.trim() ?? ''));
  expect(reasons.every((r) => r.length > 0)).toBe(true);
  await expect(rows.filter({ hasText: 'Passed' }).first()).toBeVisible();

  await expect(screen.getByTestId('learned-row').first()).toBeVisible();
});
