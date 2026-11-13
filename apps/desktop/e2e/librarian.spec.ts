import { expect, test } from '@playwright/test';
import type { CommandResult, HiveCommand, HiveSnapshot } from '@insectoids/shared';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * Phase 2 B3 through the real app with the scripted demo engine (no AI calls): a failed inspection leaves
 * a lesson, the user confirms it, the Librarian's free audit gives a health score, and its review (the demo
 * Librarian) proposes a change that applies only when the user approves it.
 */
let t: LaunchedApp;

test.beforeAll(async () => {
  // The demo Inspector fails C-01 once; the seed adds two more unconfirmed lessons for the review to find.
  t = await launchApp({ env: { INSECTOIDS_E2E_INSPECTOR_FAILS_FIRST: '1', INSECTOIDS_E2E_BRAIN_SEED: '1' } });
});

test.afterAll(async () => {
  await t?.close();
});

const snapshot = (): Promise<HiveSnapshot> => t.win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.snapshot());
const command = (cmd: HiveCommand): Promise<CommandResult> => t.win.evaluate((c) => (globalThis as unknown as AppWindow).insectoids.hive.command(c), cmd);

async function until<T>(what: string, read: () => Promise<T | undefined | null | false>, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await read().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const waitingApproval = (kind: string) =>
  until(`a waiting ${kind} approval`, async () => (await snapshot()).approvals.find((a) => a.status === 'waiting' && a.kind === kind));

test('a failed inspection leaves a lesson naming the card', async () => {
  await until('the hive', snapshot);
  expect(await command({ type: 'submitGoal', text: 'Say hello' })).toEqual({ ok: true });
  const plan = await waitingApproval('plan');
  expect(await command({ type: 'approve', approvalId: plan.id })).toEqual({ ok: true });
  const lesson = await until('the lesson', async () => (await snapshot()).lessons.find((l) => l.source === 'Write hello.txt'));
  expect(lesson).toMatchObject({ trust: 'unconfirmed', seen: 1 });
  expect(lesson.title).toMatch(/^Don't hand in "Write hello\.txt" as done because hello\.txt has no greeting/);
  // The hive retried the card and finished: the merge waits for the user.
  await waitingApproval('merge');
});

test('confirmLesson confirms it as the user', async () => {
  const lesson = (await snapshot()).lessons.find((l) => l.source === 'Write hello.txt')!;
  expect(await command({ type: 'confirmLesson', id: lesson.id })).toEqual({ ok: true });
  const after = await until('confirmed', async () => (await snapshot()).lessons.find((l) => l.id === lesson.id && l.trust === 'confirmed'));
  expect(after.trust).toBe('confirmed');
});

test('runLibrarian {review:false} gives a health score for free', async () => {
  const before = await snapshot();
  expect(await command({ type: 'runLibrarian', review: false })).toEqual({ ok: true });
  const s = await snapshot();
  expect(s.brainHealth.score).toEqual(expect.any(Number));
  expect(s.brainHealth.parts.map((p) => p.id)).toEqual(['stale', 'waiting', 'orphans', 'unused', 'duplicates', 'lessons']);
  expect(s.brainHealth.lastAuditAt).toBeGreaterThanOrEqual(before.brainHealth.lastAuditAt ?? 0);
  expect(s.librarian.state).toBe('idle');
  // The free audit never runs an agent.
  expect(s.agents.filter((a) => a.role === 'librarian')).toHaveLength(0);
});

test('runLibrarian {review:true} proposes a change that applies only on approve', async () => {
  await until('an idle hive', async () => (await snapshot()).hive.working === 0);
  const waitingBefore = (await snapshot()).lessons.filter((l) => l.trust !== 'confirmed').map((l) => l.id);
  expect(waitingBefore.length).toBeGreaterThan(0);
  expect(await command({ type: 'runLibrarian', review: true })).toEqual({ ok: true });
  const proposal = await until('a Librarian proposal', async () => (await snapshot()).approvals.find((a) => a.from === 'Librarian' && a.status === 'waiting'));
  expect(proposal.title).toMatch(/^Keep the lesson/);
  const s = await snapshot();
  expect(s.librarian.proposalsWaiting).toBe(1);
  expect(s.librarian.lastReviewAt).not.toBeNull();
  expect(s.activity.map((a) => a.message)).toContain('The Librarian found 1 thing for you to check.');
  expect(s.agents.some((a) => a.role === 'librarian' && a.goalId === null)).toBe(true);
  // Nothing changed yet.
  expect((await snapshot()).lessons.filter((l) => l.trust !== 'confirmed').map((l) => l.id)).toEqual(waitingBefore);

  expect(await command({ type: 'approve', approvalId: proposal.id })).toEqual({ ok: true });
  const confirmed = await until('the lesson confirmed', async () => {
    const now = (await snapshot()).lessons;
    return waitingBefore.find((id) => now.find((l) => l.id === id)?.trust === 'confirmed');
  });
  expect(confirmed).toBeDefined();
  expect((await snapshot()).librarian.proposalsWaiting).toBe(0);
});
