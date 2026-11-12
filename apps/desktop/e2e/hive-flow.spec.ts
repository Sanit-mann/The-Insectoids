import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { CommandResult, HiveCommand, HiveSnapshot } from '@insectoids/shared';
import { type AppWindow, type LaunchedApp, launchApp, repoGit } from './support/launch';

/**
 * Phase 1 goal, end to end, through the real app (Brain host + hive + workspace + git) with the scripted
 * demo engine: give a goal, approve the plan, insects work, the Inspector verifies, approve the merge,
 * then undo and redo it. Driven through (globalThis as unknown as AppWindow).insectoids.hive only, so it does not depend on the UI.
 */
let t: LaunchedApp;

test.beforeAll(async () => {
  t = await launchApp();
});

test.afterAll(async () => {
  await t?.close();
});

const snapshot = (): Promise<HiveSnapshot> => t.win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.snapshot());
const command = (cmd: HiveCommand): Promise<CommandResult> => t.win.evaluate((c) => (globalThis as unknown as AppWindow).insectoids.hive.command(c), cmd);

async function until<T>(what: string, read: () => Promise<T | undefined | null | false>, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const waitingApproval = (kind: string) =>
  until(`a waiting ${kind} approval`, async () => (await snapshot()).approvals.find((a) => a.status === 'waiting' && a.kind === kind));

const onMain = (file: string): boolean => existsSync(join(t.repo, file));

test('the hive knows the project and runs the demo engine', async () => {
  const s = await until('the hive', async () => {
    try {
      return await snapshot();
    } catch {
      return null;
    }
  });
  expect(s.project?.name).toBe('sample project');
  expect(s.project?.shelf).toBe('sample-project');
  expect(s.project?.branch).toBe('main');
  expect(s.engine.state).toBe('fake');
});

test('refuses bad commands with plain words', async () => {
  const r = await command({ type: 'approve', approvalId: 'nope' });
  expect(r).toEqual({ ok: false, error: 'No approval nope' });
  await expect(t.win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.command({ type: 'submitGoal', text: '' } as never))).rejects.toThrow();
});

test('goal → plan approval → insects → Inspector → merge → undo → redo', async () => {
  const pushes: string[] = [];
  await t.win.evaluate(() => {
    (globalThis as Record<string, unknown>)['__pushes'] = [];
    (globalThis as unknown as AppWindow).insectoids.hive.onEvent((e) => ((globalThis as Record<string, unknown>)['__pushes'] as unknown[]).push(e.type));
  });

  expect(await command({ type: 'submitGoal', text: 'Say hello to the world' })).toEqual({ ok: true });

  // A 2-wave plan is big: it waits for approval (Hive 02-D11).
  const plan = await waitingApproval('plan');
  let s = await snapshot();
  const goal = s.goals[0]!;
  expect(goal.status).toBe('awaiting_approval');
  expect(goal.plan?.summary).toBe('Say hello');
  expect(goal.plan?.waves.map((w) => w.cards.map((c) => c.title))).toEqual([['Write hello.txt', 'Check hello.txt'], ['Write README note']]);
  expect(s.agents.some((a) => a.role === 'queen' && a.status === 'done' && a.model)).toBe(true);
  expect(await command({ type: 'approve', approvalId: plan.id })).toEqual({ ok: true });

  // Insects work, the Inspector verifies each card; then the merge into main waits for you.
  const merge = await waitingApproval('merge');
  s = await snapshot();
  expect(s.cards.map((c) => [c.title, c.status])).toEqual([
    ['Write hello.txt', 'done'],
    ['Check hello.txt', 'done'],
    ['Write README note', 'done'],
  ]);
  expect(s.goals[0]!.merge).toBe('awaiting-approval');
  const lanes = s.agents.filter((a) => a.role === 'insect');
  expect(lanes.length).toBe(3);
  expect(lanes.every((l) => l.status === 'done' && l.tokens > 0 && l.output.some((o) => o.includes('Write')))).toBe(true);
  expect(s.agents.filter((a) => a.role === 'inspector').length).toBe(3);
  expect(s.activity.some((a) => a.type === 'card-verified')).toBe(true);
  expect(onMain('C-01.txt')).toBe(false);

  // A card's changes are viewable.
  const first = s.cards[0]!;
  const changes = await t.win.evaluate((r) => (globalThis as unknown as AppWindow).insectoids.hive.changes(r), { goalId: first.goalId, cardId: first.id });
  expect(changes.files).toEqual([{ path: 'C-01.txt', status: 'added' }]);
  expect(changes.patch).toContain('+Hello from');

  expect(await command({ type: 'approve', approvalId: merge.id })).toEqual({ ok: true });
  s = await snapshot();
  expect(s.goals[0]!.status).toBe('done');
  expect(s.goals[0]!.merge).toBe('merged');
  expect(onMain('C-01.txt') && onMain('C-02.txt') && onMain('C-03.txt')).toBe(true);

  // Undo the merge (approval, destructive) …
  expect(await command({ type: 'requestUndoMerge', goalId: goal.id })).toEqual({ ok: true });
  const undo = await waitingApproval('merge');
  expect(undo.destructive).toBe(true);
  expect(await command({ type: 'approve', approvalId: undo.id })).toEqual({ ok: true });
  expect((await snapshot()).goals[0]!.merge).toBe('undone');
  expect(onMain('C-01.txt')).toBe(false);

  // … and redo it.
  expect(await command({ type: 'requestRedoMerge', goalId: goal.id })).toEqual({ ok: true });
  const redo = await waitingApproval('merge');
  expect(await command({ type: 'approve', approvalId: redo.id })).toEqual({ ok: true });
  expect((await snapshot()).goals[0]!.merge).toBe('merged');
  expect(onMain('C-01.txt')).toBe(true);
  expect(repoGit(t.repo, 'status', '--porcelain').trim()).toBe('');

  // The Brain recorded the goal and its outcomes.
  const recent = await t.win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.brainSearch({ query: '' }));
  expect(recent.some((h) => h.kind === 'outcome' && h.title.includes('verified'))).toBe(true);
  const hits = await t.win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.brainSearch({ query: 'hello' }));
  expect(hits.length).toBeGreaterThan(0);
  const rec = await t.win.evaluate((id) => (globalThis as unknown as AppWindow).insectoids.hive.brainRecord(id), hits[0]!.id);
  expect(rec?.history.length).toBeGreaterThan(0);

  pushes.push(...(await t.win.evaluate(() => (globalThis as Record<string, unknown>)['__pushes'] as string[])));
  expect(pushes).toContain('changed');
  expect(pushes).toContain('agent-output');
});
