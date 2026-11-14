import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { type Engine, FakeEngine, demoEngine } from '@insectoids/harness';
import { type HiveSnapshot, HiveSnapshotSchema } from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HiveManager } from '../brain-host/hive-manager';

/** The Librarian in the host (Phase 2 B3): audit timer, health, lessons, review gating, approve/deny. */
const libraryDir = fileURLToPath(new URL('../../../../library', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const lib = { type: 'agent', id: 'Librarian' } as const;

let root: string;
let repo: string;
let brain: Brain;
let manager: HiveManager | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-lib-hm-'));
  repo = join(root, 'site');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'README.md'), '# Site\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  brain = openBrain(':memory:');
  manager = null;
});

afterEach(async () => {
  await manager?.dispose();
  await new Promise((r) => setTimeout(r, 50));
  brain.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function make(o: { engine?: Engine; intervalMs?: number; reviewEveryCards?: number; insectMs?: number; failFirst?: boolean; shiftDays?: number; seed?: boolean } = {}): HiveManager {
  manager = new HiveManager({
    brain,
    tokens: null,
    doors: null,
    userDataDir: join(root, 'userData'),
    libraryDir,
    engine: 'fake',
    engineOverride: o.engine ?? demoEngine({ queenMs: 5, insectMs: o.insectMs ?? 20, inspectorMs: 5, ...(o.failFirst ? { inspectorFailsFirst: true } : {}) }),
    project: repo,
    push: () => {},
    tickMs: 20,
    seed: 1,
    geminiDetect: async () => ({ status: 'missing' }),
    tidy: { ...(o.intervalMs ? { intervalMs: o.intervalMs } : {}), ...(o.shiftDays ? { clockShiftDays: o.shiftDays } : {}) },
    librarian: { reviewEveryCards: o.reviewEveryCards ?? 1000 },
    ...(o.seed ? { seedBrainForE2E: true } : {}),
  });
  return manager;
}

const snap = (m: HiveManager): HiveSnapshot => HiveSnapshotSchema.parse(m.snapshot());
const librarianApprovals = (m: HiveManager) => snap(m).approvals.filter((a) => a.from === 'Librarian');

async function until<T>(what: string, read: () => T | undefined | null | false, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const lesson = (title: string) => brain.learn({ shelf: 'site', title, body: `Card: x\nWhat the Inspector found: ${title}` }, lib).id;

describe('the Librarian in the host (B3)', () => {
  // Phase 3 A5: periodic scoring moved from the Librarian's timer to the built-in "Brain health check" job, so the
  // second audit comes from that job (run now here; its schedule is 6 hours).
  it('audits at start and with the Brain health check job: the snapshot carries a health score', async () => {
    const m = make({ intervalMs: 40 });
    expect(snap(m).brainHealth.score).toBeNull();
    await m.init();
    const first = snap(m);
    expect(first.brainHealth.score).toBe(100);
    expect(first.librarian).toMatchObject({ state: 'idle', lastReviewAt: null, proposalsWaiting: 0 });
    expect(first.librarian.nextReview).toMatch(/finished cards or in 7 days/);
    const at = first.brainHealth.lastAuditAt!;
    await new Promise((r) => setTimeout(r, 5));
    expect(await m.command({ type: 'runCadenceNow', id: 'maint-brain-audit' })).toEqual({ ok: true });
    expect(snap(m).brainHealth.lastAuditAt).toBeGreaterThan(at);
    expect(m.cadenceRuns({ cadenceId: 'maint-brain-audit' })[0]).toMatchObject({ reason: 'manual', outcome: 'done', message: expect.stringMatching(/^Brain health 100\/100\./) });
  });

  it('the start audit runs before the e2e seed: with the decay clock 90 days ahead, seeded records stay', async () => {
    const m = make({ seed: true, shiftDays: 90 });
    await m.init();
    expect(brain.search('checkout stripe', { shelf: 'site' })).toHaveLength(1);
    expect(brain.search('hosting provider', { shelf: 'site' }).map((h) => h.status)).toEqual(['current']);
    expect(snap(m).lessons.filter((l) => l.trust === 'unconfirmed')).toHaveLength(2);
    expect(snap(m).brainHealth.score).not.toBeNull();
  });

  it('runLibrarian {review:false} scores the Brain and never calls an engine', async () => {
    const engine = demoEngine({ queenMs: 5, insectMs: 20, inspectorMs: 5 });
    const m = make({ engine });
    await m.init();
    for (let i = 0; i < 3; i++) brain.write({ kind: 'fact', shelf: 'site', title: `Proposed fact ${i}`, body: `Fact number ${i} about the site.` }, { type: 'agent', id: 'Ant-1' });
    expect(await m.command({ type: 'runLibrarian', review: false })).toEqual({ ok: true });
    const h = snap(m).brainHealth;
    expect(h.parts.find((p) => p.id === 'waiting')).toMatchObject({ count: 3, penalty: 6 });
    expect(h.score).toBe(94);
    expect(engine.calls).toHaveLength(0);
  });

  it('lessons show in the snapshot; the user confirms or retires them', async () => {
    const a = lesson("Don't hand in the form as done because the submit button does nothing");
    const b = lesson("Don't hand in the docs as done because the links are broken");
    const m = make();
    await m.init();
    expect(snap(m).lessons.map((l) => l.id).sort()).toEqual([a, b].sort());
    expect(await m.command({ type: 'confirmLesson', id: a })).toEqual({ ok: true });
    expect(brain.get(a)).toMatchObject({ trust: 'confirmed' });
    expect(await m.command({ type: 'retireLesson', id: b })).toEqual({ ok: true });
    expect(brain.get(b)).toMatchObject({ archived: true, archivedReason: 'retired by you' });
    expect(snap(m).lessons.map((l) => l.id)).toEqual([a]);
    // Only lessons: other records can't be confirmed through this door.
    const fact = brain.write({ kind: 'fact', shelf: 'site', title: 'A fact', body: 'Not a lesson.' }, { type: 'agent', id: 'Ant-1' }).id;
    expect(await m.command({ type: 'confirmLesson', id: fact })).toEqual({ ok: false, error: 'No such lesson.' });
  });

  it('a failed inspection leaves a lesson naming the card', async () => {
    const m = make({ failFirst: true });
    await m.init();
    await m.command({ type: 'submitGoal', text: 'Say hello' });
    const plan = await until('plan approval', () => snap(m).approvals.find((x) => x.status === 'waiting'));
    await m.command({ type: 'approve', approvalId: plan.id });
    const l = await until('a lesson', () => snap(m).lessons[0]);
    expect(l).toMatchObject({ trust: 'unconfirmed', source: 'Write hello.txt', seen: 1 });
    expect(l.title).toMatch(/^Don't hand in "Write hello\.txt" as done because hello\.txt has no greeting/);
  });

  it('review gating: needs an engine-ready, unpaused, idle hive', async () => {
    lesson("Don't hand in the form as done because the submit button does nothing");
    const m = make({ insectMs: 1500 });
    await m.init();
    await m.command({ type: 'pause' });
    expect(await m.command({ type: 'runLibrarian', review: true })).toEqual({ ok: false, error: "The Librarian can't review now: The hive is paused." });
    await m.command({ type: 'resume' });
    await m.command({ type: 'submitGoal', text: 'Say hello' });
    const plan = await until('plan approval', () => snap(m).approvals.find((x) => x.status === 'waiting'));
    await m.command({ type: 'approve', approvalId: plan.id });
    await until('an insect working', () => snap(m).hive.working > 0);
    const r = await m.command({ type: 'runLibrarian', review: true });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/Agents are working/) });
    expect(librarianApprovals(m)).toHaveLength(0);
  });

  it('review: a proposal becomes an approval; yes applies it as the user, no changes nothing', async () => {
    const a = lesson("Don't hand in the form as done because the submit button does nothing");
    const b = lesson("Don't hand in the docs as done because the links are broken");
    const m = make();
    await m.init();
    expect(await m.command({ type: 'runLibrarian', review: true })).toEqual({ ok: true });
    const first = await until('a Librarian proposal', () => librarianApprovals(m).find((x) => x.status === 'waiting'));
    expect(first.title).toMatch(/^Keep the lesson/);
    expect(snap(m).librarian).toMatchObject({ proposalsWaiting: 1, state: 'idle' });
    expect(snap(m).activity.map((x) => x.message)).toContain('The Librarian found 1 thing for you to check.');
    await m.command({ type: 'approve', approvalId: first.id });
    const confirmed = [a, b].find((id) => brain.get(id)!.trust === 'confirmed')!;
    expect(confirmed).toBeDefined();
    expect(brain.history(confirmed).at(-1)).toMatchObject({ change: 'update', changedBy: 'user', trust: 'confirmed' });

    // The next review proposes the other lesson; the user says no and nothing changes.
    const other = confirmed === a ? b : a;
    expect(await m.command({ type: 'runLibrarian', review: true })).toEqual({ ok: true });
    const second = await until('a second proposal', () => librarianApprovals(m).find((x) => x.status === 'waiting'));
    await m.command({ type: 'deny', approvalId: second.id });
    expect(brain.get(other)).toMatchObject({ trust: 'unconfirmed', archived: false });
    expect(snap(m).librarian.lastReviewAt).not.toBeNull();
  });

  it('a reply that is not valid JSON gives no proposals and one plain activity line', async () => {
    lesson("Don't hand in the form as done because the submit button does nothing");
    const engine = new FakeEngine((req) => (req.role === 'librarian' ? { text: 'I think it all looks fine {not json' } : { text: 'STATUS: DONE' }));
    const m = make({ engine });
    await m.init();
    await m.command({ type: 'runLibrarian', review: true });
    await until('the review line', () => snap(m).activity.find((x) => x.type === 'librarian'));
    expect(snap(m).activity.filter((x) => x.type === 'librarian').map((x) => x.message)).toEqual([
      "The Librarian's review gave nothing usable (The Librarian's reply was not valid JSON.). Nothing changed.",
    ]);
    expect(librarianApprovals(m)).toHaveLength(0);
  });

  it('wakes on its own after enough finished cards, once the hive is idle', async () => {
    lesson("Don't hand in the form as done because the submit button does nothing");
    const m = make({ reviewEveryCards: 2 });
    await m.init();
    await m.command({ type: 'submitGoal', text: 'Say hello' });
    const plan = await until('plan approval', () => snap(m).approvals.find((x) => x.status === 'waiting'));
    await m.command({ type: 'approve', approvalId: plan.id });
    await until('a Librarian proposal', () => librarianApprovals(m).length > 0);
    expect(snap(m).agents.some((a) => a.role === 'librarian' && a.goalId === null)).toBe(true);
  });
});
