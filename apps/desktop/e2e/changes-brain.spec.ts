import { expect, test } from '@playwright/test';
import type { HiveSnapshot } from '@insectoids/shared';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * Changes & undo and the Brain reader (Phase 1 Step 8), driven end to end by the scripted fake engine:
 * the Queen plans "Say hello": "Write hello.txt" + "Check hello.txt" (wave 1), "Write README note" (wave 2).
 */
let t: LaunchedApp;

const snapshot = (): Promise<HiveSnapshot> => t.win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.snapshot());
const nav = (name: string) => t.win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true });
const approveWaiting = async (kind: string): Promise<void> => {
  let id: string | null = null;
  await expect
    .poll(async () => (id = (await snapshot()).approvals.find((a) => a.kind === kind && a.status === 'waiting')?.id ?? null), { timeout: 60_000 })
    .not.toBeNull();
  const approvalId = id!;
  expect(await t.win.evaluate((a) => (globalThis as unknown as AppWindow).insectoids.hive.command({ type: 'approve', approvalId: a }), approvalId)).toEqual({ ok: true });
};

test.beforeAll(async () => {
  t = await launchApp();
  // Brain commands refuse with "Starting the Brain…" until the Brain host is ready.
  await expect(t.win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
});

test.afterAll(async () => {
  await t?.close();
});

test('Changes explains itself before there is a goal', async () => {
  await nav('Changes').click();
  await expect(t.win.getByRole('heading', { name: 'No changes yet' })).toBeVisible();
});

test('the hive finishes the goal and asks before merging', async () => {
  const r = await t.win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.command({ type: 'submitGoal', text: 'Say hello' }));
  expect(r).toEqual({ ok: true });
  await approveWaiting('plan');
  await expect
    .poll(async () => {
      const s = await snapshot();
      return s.cards.length === 3 && s.cards.every((c) => c.status === 'done') ? s.goals[0]?.merge : 'working';
    }, { timeout: 120_000 })
    .toBe('awaiting-approval');
});

test('a card shows the files it changed, with a readable diff', async () => {
  const s = await snapshot();
  const card = s.cards.find((c) => c.title === 'Write hello.txt')!;
  const changes = await t.win.evaluate((c) => (globalThis as unknown as AppWindow).insectoids.hive.changes({ goalId: c.goalId, cardId: c.id }), card);
  expect(changes.files.length).toBeGreaterThan(0);

  await nav('Changes').click();
  await t.win.getByTestId('changes-card').filter({ hasText: 'Write hello.txt' }).click();
  await expect(t.win.getByRole('heading', { name: 'Write hello.txt' })).toBeVisible();
  const file = t.win.getByTestId('diff-file').filter({ hasText: changes.files[0]!.path.split('/').pop()! });
  await expect(file).toBeVisible();
  // The first file opens by default; added lines carry a "+" sign, not colour alone.
  await expect(t.win.locator('[data-line="add"]').first()).toContainText('+');
});

test('Undo card reverts a card and marks it undone', async () => {
  await t.win.getByTestId('changes-card').filter({ hasText: 'Write README note' }).click();
  await expect(t.win.getByRole('heading', { name: 'Write README note' })).toBeVisible();
  // The undo window (5 s) closes, then the hive reverts the card.
  await t.win.getByTestId('undo-card').click();
  // The undo clock pauses while the pointer rests on the button (Kokonut undo-button), so move away.
  await t.win.mouse.move(0, 0);
  await expect(t.win.getByTestId('undone-tag')).toBeVisible({ timeout: 30_000 });
  await expect(t.win.getByTestId('card-status')).toHaveText('Undone');
  await expect.poll(async () => (await snapshot()).cards.find((c) => c.title === 'Write README note')?.undone, { timeout: 10_000 }).toBe(true);
});

test('after the merge, "Undo merge" asks for approval', async () => {
  await approveWaiting('merge');
  await expect.poll(async () => (await snapshot()).goals[0]?.merge, { timeout: 30_000 }).toBe('merged');

  const goalTitle = (await snapshot()).goals[0]!.title;
  await t.win.getByRole('navigation', { name: 'Goals and cards' }).getByRole('button', { name: new RegExp(`^${goalTitle}`) }).click();
  const panel = t.win.getByTestId('merge-panel');
  await expect(panel).toHaveAttribute('data-merge', 'merged');
  const waitingBefore = (await snapshot()).approvals.filter((a) => a.status === 'waiting').length;
  await panel.getByRole('button', { name: 'Undo merge' }).click();
  await expect(panel.getByRole('status')).toContainText('Undo requested');
  await expect.poll(async () => (await snapshot()).approvals.filter((a) => a.status === 'waiting').length, { timeout: 10_000 }).toBe(waitingBefore + 1);
});

test('the Brain finds the goal and opens it with its trust level', async () => {
  await nav('Brain').click();
  // Phase 2 B5: the graph is a real view now, next to Notes.
  await expect(t.win.getByTestId('brain-view-switch').getByRole('tab', { name: 'Graph' })).toBeVisible();
  await t.win.getByTestId('brain-search').fill('hello');
  const hit = t.win.getByTestId('brain-hit').filter({ hasText: 'Say hello' }).first();
  await expect(hit).toBeVisible({ timeout: 10_000 });
  await hit.click();
  const reader = t.win.getByTestId('brain-reader');
  await expect(reader.getByRole('heading', { name: /Say hello/ })).toBeVisible();
  // The user gave the goal, so the record is confirmed (Memory 01-D3); trust is shown as words.
  await expect(reader.getByTestId('trust-badge')).toHaveText('Confirmed');
  // Phase 2 B5: the user can edit it (saved as a new version; brain-edit-ui covers the rest).
  await expect(reader.getByRole('button', { name: 'Edit' })).toBeEnabled();
});
