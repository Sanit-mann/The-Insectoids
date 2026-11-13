import { expect, test } from '@playwright/test';
import type { HiveApi } from '@insectoids/shared';
import { type LaunchedApp, launchApp } from './support/launch';

/**
 * Taskboard and Hive monitor (Phase 1 Step 8), driven end to end by the scripted fake engine:
 * the Queen plans "Write hello.txt" + "Check hello.txt" (wave 1) and "Write README note" (wave 2).
 */
let t: LaunchedApp;
/** The e2e tsconfig has no DOM types; this is `window` inside win.evaluate. */
type Win = { insectoids: { hive: HiveApi; brainStatus(): Promise<{ state: string }> } };

test.beforeAll(async () => {
  t = await launchApp();
  // Hive commands need the Brain host up.
  await expect
    .poll(() => t.win.evaluate(async () => (await (globalThis as unknown as Win).insectoids.brainStatus()).state), { timeout: 30_000 })
    .toBe('ready');
});

test.afterAll(async () => {
  await t?.close();
});

const nav = (name: string) => t.win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true });

test('the taskboard explains itself before there is a goal', async () => {
  await nav('Taskboard').click();
  await expect(t.win.getByRole('heading', { name: 'No task cards yet' })).toBeVisible();
  await nav('Hive').click();
  await expect(t.win.getByText('No insects working. Give the Queen a goal.')).toBeVisible();
});

test('cards move across the board to Done after the plan is approved', async () => {
  const submitted = await t.win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.command({ type: 'submitGoal', text: 'Say hello' }));
  expect(submitted).toEqual({ ok: true });

  // The plan has two waves, so it waits for approval (Hive 02-D11).
  let approvalId: string | null = null;
  await expect
    .poll(
      async () =>
        (approvalId = await t.win.evaluate(async () => {
          const s = await (globalThis as unknown as Win).insectoids.hive.snapshot();
          return s.approvals.find((a) => a.kind === 'plan' && a.status === 'waiting')?.id ?? null;
        })),
      { timeout: 30_000 },
    )
    .not.toBeNull();
  const id = approvalId!;
  expect(await t.win.evaluate((a) => (globalThis as unknown as Win).insectoids.hive.command({ type: 'approve', approvalId: a }), id)).toEqual({ ok: true });

  await nav('Taskboard').click();
  const done = t.win.getByRole('region', { name: /^Done,/ });
  await expect(done.getByRole('button', { name: /^Write hello\.txt\./ })).toBeVisible({ timeout: 60_000 });
  await expect(done.getByRole('button', { name: /^Check hello\.txt\./ })).toBeVisible({ timeout: 60_000 });

  // Wave filter and goal switcher are present.
  await expect(t.win.getByRole('group', { name: 'Wave' }).getByRole('button', { name: 'All waves' })).toHaveAttribute('aria-pressed', 'true');
  await expect(t.win.getByRole('combobox', { name: 'Goal' })).toBeVisible();
});

test('a card opens its detail with "done means"', async () => {
  await nav('Taskboard').click();
  await t.win.getByRole('button', { name: /^Write hello\.txt\./ }).click();
  const detail = t.win.getByRole('complementary', { name: 'Card details' });
  await expect(detail.getByRole('heading', { name: 'Write hello.txt' })).toBeVisible();
  await expect(detail.getByRole('region', { name: 'Done means' }).getByRole('listitem').first()).toBeVisible();
  await expect(detail.getByText('Attempts')).toBeVisible();

  // Keyboard: Enter on a focused card toggles the detail.
  await detail.getByRole('button', { name: 'Close card details' }).click();
  await expect(detail).toBeHidden();
  await t.win.getByRole('button', { name: /^Write hello\.txt\./ }).focus();
  await t.win.keyboard.press('Enter');
  await expect(t.win.getByRole('complementary', { name: 'Card details' })).toBeVisible();
});

test('the hive monitor lists insect lanes with their live output', async () => {
  await nav('Hive').click();
  const table = t.win.getByRole('table');
  await expect(table.getByRole('button', { name: /^Coder/ }).first()).toBeVisible({ timeout: 30_000 });
  await expect(table.getByRole('button', { name: /^Tester/ }).first()).toBeVisible();

  await table.getByRole('button', { name: /^Coder/ }).first().click();
  const panel = t.win.getByRole('complementary', { name: 'Selected agent' });
  await expect(panel.getByRole('heading', { name: /^Coder/ })).toBeVisible();
  const log = panel.getByRole('log');
  await expect(log).not.toHaveText('No output yet.', { timeout: 30_000 });
  await expect(log).toHaveText(/\S/);
  await expect(panel.getByRole('button', { name: 'Take over' })).toBeDisabled();
  // The living hive is a real view since Phase 2 C4 (living-hive.spec covers it).
  await expect(t.win.getByRole('tab', { name: /Living hive/ })).toBeEnabled();
});

test('pause and resume the hive', async () => {
  await nav('Hive').click();
  const controls = t.win.getByRole('group', { name: 'Hive controls' });
  await controls.getByRole('button', { name: 'Pause hive' }).click();
  await expect(controls.getByRole('button', { name: 'Resume hive' })).toBeVisible();
  await expect(t.win.getByRole('status', { name: 'Hive paused' })).toContainText('Paused by you');
  await controls.getByRole('button', { name: 'Resume hive' }).click();
  await expect(controls.getByRole('button', { name: 'Pause hive' })).toBeVisible();
  await expect(t.win.getByRole('status', { name: 'Hive paused' })).toBeHidden();
});
