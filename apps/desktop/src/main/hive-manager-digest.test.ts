import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { demoEngine } from '@insectoids/harness';
import {
  type CadenceInput,
  CadenceInputSchema,
  type DigestView,
  DigestViewSchema,
  type HiveSnapshot,
  HiveSnapshotSchema,
  MAINTENANCE_JOB_ORDER,
  maintenanceCadenceId,
} from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HiveManager } from '../brain-host/hive-manager';
import { SAMPLE_GOAL_TEXT } from './practice-project';

/**
 * The "while you were away" digest in the host (Cadence 05-D8; Phase 3 B1). Interval "minutes" are 20 ms here, so
 * a 15-minute cadence fires after 300 ms. The built-in jobs are switched off unless a test needs one, so their
 * schedules never add runs by surprise.
 */
const libraryDir = fileURLToPath(new URL('../../../../library', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const UNIT = 20;
const SKIP_WORDS = 'its next runs are skipped until then.';

let root: string;
let brain: Brain;
/** Added to the real clock (Brain and host alike). */
let shift: number;
let managers: HiveManager[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-digest-hm-'));
  shift = 0;
  brain = openBrain(':memory:', { now: () => Date.now() + shift });
  managers = [];
});

afterEach(async () => {
  for (const m of managers) await m.dispose();
  await new Promise((r) => setTimeout(r, 50));
  brain.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function makeRepo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'greet.js'), 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

async function make(o: { project?: string; jobs?: boolean } = {}): Promise<HiveManager> {
  const m = new HiveManager({
    brain,
    tokens: null,
    doors: null,
    userDataDir: join(root, 'userData'),
    libraryDir,
    engine: 'fake',
    engineOverride: demoEngine({ queenMs: 5, insectMs: 20, inspectorMs: 5 }),
    ...(o.project ? { project: o.project } : {}),
    push: () => {},
    tickMs: 20,
    seed: 1,
    now: () => Date.now() + shift,
    geminiDetect: async () => ({ status: 'missing' }),
    cadence: { intervalUnitMs: UNIT, recheckMs: 25 },
  });
  managers.push(m);
  if (!o.jobs) for (const j of MAINTENANCE_JOB_ORDER) brain.cadences.setEnabled(maintenanceCadenceId(j), false, null);
  await m.init();
  return m;
}

async function until<T>(what: string, read: () => T | undefined | null | false, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const snap = (m: HiveManager): HiveSnapshot => HiveSnapshotSchema.parse(m.snapshot());
const digest = (m: HiveManager): DigestView => DigestViewSchema.parse(m.digest());
const ok = async (m: HiveManager, cmd: Parameters<HiveManager['command']>[0]) => expect(await m.command(cmd)).toEqual({ ok: true });
const cadence = (o: Partial<CadenceInput> = {}) =>
  CadenceInputSchema.parse({ name: 'Weekly report', when: { type: 'interval', everyMinutes: 15 }, goal: SAMPLE_GOAL_TEXT, budgetTokens: 40_000, autonomy: 'small-plans', ...o });
const settings = () => JSON.parse(readFileSync(join(root, 'userData', 'settings.json'), 'utf8')) as { digestSeenAt?: number };
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('the "while you were away" digest (Cadence 05-D8; Phase 3 B1)', () => {
  it('on the very first start nothing is unseen, and that moment is saved', async () => {
    const before = Date.now();
    const m = await make();
    const s = snap(m).digest;
    expect(s).toMatchObject({ unseen: false, headline: null });
    expect(s.since).toBeGreaterThanOrEqual(before);
    expect(settings().digestSeenAt).toBe(s.since);
    const d = digest(m);
    expect(d).toMatchObject({ unseen: false, headline: null, cadences: [], waiting: { total: 0, items: [] } });
    expect(d.totals).toEqual({ runs: 0, goalsDone: 0, goalsFailed: 0, goalsOpen: 0, problems: 0, jobs: 0, tokens: 0, costUsd: 0 });
  });

  it('a scheduled run while away is unseen and listed with its goal, its spend, and what it waits for', async () => {
    const m = await make({ project: makeRepo('site') });
    await ok(m, { type: 'createCadence', cadence: cadence() });
    const id = snap(m).cadences.find((c) => !c.builtIn)!.id;
    const goal = await until('the cadence starts a goal', () => brain.goals.list().find((g) => g.cadenceId === id));
    // One wave, small plans: it runs on its own; its merge waits for the user, and that holds back the next runs.
    await until('the merge waits', () => brain.approvals.list({ status: 'waiting' }).some((a) => a.goalId === goal.id && a.kind === 'merge'));
    await until('a skipped run', () => m.cadenceRuns({ cadenceId: id }).some((r) => r.outcome === 'skipped'));
    const spent = brain.goals.get(goal.id)!;
    brain.goals.addSpend(goal.id, 41_200 - spent.spentTokens, 0.12 - spent.spentUsd);

    const d = digest(m);
    expect(d.unseen).toBe(true);
    expect(d.cadences).toHaveLength(1);
    const c = d.cadences[0]!;
    expect(c).toMatchObject({ cadenceId: id, name: 'Weekly report', builtIn: false });
    expect(c.outcomes['started']).toBe(1);
    expect(c.outcomes['skipped']).toBeGreaterThanOrEqual(1);
    expect(c.goals).toEqual([
      expect.objectContaining({ goalId: goal.id, title: 'Weekly report', status: 'running', waitingFor: 'merge', spentTokens: 41_200, startedAt: goal.createdAt }),
    ]);
    expect(c.goals[0]!.spentUsd).toBeCloseTo(0.12, 6);
    expect(c.goals[0]!.outcome).toBe(`Waiting for you to approve its merge; ${SKIP_WORDS}`);
    expect(c.lines.length).toBeGreaterThan(0);
    expect(c.lines.length).toBeLessThanOrEqual(5);
    expect(d.totals).toMatchObject({ runs: 1, goalsDone: 0, goalsOpen: 1, tokens: 41_200, jobs: 0 });
    expect(d.totals.problems).toBe(c.outcomes['skipped']);
    expect(d.waiting.byKind['merge']).toBe(1);
    expect(d.headline).toMatch(/^While you were away: 1 run, 1 waits for you, \d+ runs? skipped or put off\. 41,200 tokens \(\$0\.12\)\.$/);
    expect(snap(m).digest).toEqual({ unseen: true, since: d.since, headline: d.headline });
  });

  it('a run the user started ("Run now") is not in the digest', async () => {
    const m = await make({ project: makeRepo('site'), jobs: true });
    await ok(m, { type: 'createCadence', cadence: cadence({ when: { type: 'interval', everyMinutes: 7 * 24 * 60 } }) });
    const id = snap(m).cadences.find((c) => !c.builtIn)!.id;
    await ok(m, { type: 'runCadenceNow', id });
    await ok(m, { type: 'runCadenceNow', id: 'maint-stale-tasks' });
    expect(m.cadenceRuns({ cadenceId: id })[0]).toMatchObject({ reason: 'manual', outcome: 'started' });
    expect(m.cadenceRuns({ cadenceId: 'maint-stale-tasks' })[0]).toMatchObject({ reason: 'manual', outcome: 'done' });
    expect(digest(m)).toMatchObject({ unseen: false, headline: null, cadences: [] });
    expect(snap(m).digest).toMatchObject({ unseen: false, headline: null });
  });

  it('routine housekeeping is listed but never makes it unseen', async () => {
    const m = await make();
    await ok(m, { type: 'setCadenceEnabled', id: 'maint-stale-tasks', enabled: true });
    await ok(m, { type: 'updateCadence', id: 'maint-stale-tasks', cadence: cadence({ when: { type: 'interval', everyMinutes: 15 } }) });
    await until('a scheduled job run', () => m.cadenceRuns({ cadenceId: 'maint-stale-tasks' })[0]);
    await ok(m, { type: 'setCadenceEnabled', id: 'maint-stale-tasks', enabled: false });
    const d = digest(m);
    expect(d.unseen).toBe(false);
    expect(d.cadences.map((c) => [c.cadenceId, c.builtIn])).toEqual([['maint-stale-tasks', true]]);
    expect(d.cadences[0]!.lines[0]).toMatchObject({ outcome: 'done', message: 'No stale cards.' });
    expect(d.totals.jobs).toBe(d.cadences[0]!.outcomes['done']);
    expect(d.headline).toMatch(/^While you were away: housekeeping ran \d+ times?; nothing needs you\.$/);
    expect(snap(m).digest).toMatchObject({ unseen: false, headline: d.headline });
  });

  it('a failed job makes it unseen; "Got it" clears it, and that survives a restart', async () => {
    const m = await make();
    await tick();
    brain.cadences.recordRun({ cadenceId: 'maint-brain-audit', reason: 'schedule', outcome: 'done', message: 'Brain health 90/100.' });
    await tick();
    brain.cadences.recordRun({ cadenceId: 'maint-backup', reason: 'schedule', outcome: 'failed', message: 'No backups folder yet.' });
    const d = digest(m);
    expect(d.unseen).toBe(true);
    // Built-ins in the jobs' own order.
    expect(d.cadences.map((c) => c.cadenceId)).toEqual(['maint-brain-audit', 'maint-backup']);
    expect(d.cadences[1]!.lines).toEqual([expect.objectContaining({ outcome: 'failed', message: 'No backups folder yet.' })]);
    expect(d.totals).toMatchObject({ jobs: 2, problems: 1, runs: 0 });
    expect(d.headline).toBe('While you were away: housekeeping ran 2 times, 1 failed.');

    await tick();
    await ok(m, { type: 'markDigestSeen' });
    const seen = snap(m).digest;
    expect(seen).toMatchObject({ unseen: false, headline: null });
    expect(seen.since).toBeGreaterThan(d.since);
    expect(settings().digestSeenAt).toBe(seen.since);
    expect(digest(m).cadences).toEqual([]);

    await m.dispose();
    const again = await make();
    expect(snap(again).digest).toEqual({ unseen: false, since: seen.since, headline: null });
    await tick();
    brain.cadences.recordRun({ cadenceId: 'maint-backup', reason: 'wake', outcome: 'failed', message: 'Disk full.' });
    expect(snap(again).digest).toMatchObject({ unseen: true, since: seen.since, headline: 'While you were away: housekeeping ran 1 time, 1 failed.' });
  });

  it('counts everything waiting for the user now, by kind, with the oldest five', async () => {
    const m = await make({ project: makeRepo('site') });
    const shelf = m.project!.shelf;
    const ask = (kind: 'schedule' | 'webhook' | 'plan', goalId?: string) => {
      shift += 1_000;
      return brain.approvals.create({ kind, title: `${kind} ${shift}`, from: 'Queen', whyItNeedsYou: 'Why.', ifYouSayYes: 'Yes.', ...(goalId ? { goalId } : {}) });
    };
    const mine = brain.goals.create({ title: 'Mine', text: 'Mine', shelf });
    const theirs = brain.goals.create({ title: 'Theirs', text: 'Theirs', shelf: 'other-project' });
    const first = ask('schedule');
    for (let i = 0; i < 3; i++) ask('schedule');
    ask('webhook');
    ask('plan', mine.id);
    ask('plan', theirs.id);
    brain.approvals.decide(ask('schedule').id, 'denied', { type: 'user' });

    const d = digest(m);
    expect(d.waiting.total).toBe(6);
    expect(d.waiting.byKind).toEqual({ schedule: 4, webhook: 1, plan: 1 });
    expect(d.waiting.items).toHaveLength(5);
    expect(d.waiting.items[0]).toMatchObject({ id: first.id, status: 'waiting' });
    expect(d.waiting.items.map((a) => a.createdAt)).toEqual([...d.waiting.items.map((a) => a.createdAt)].sort((a, b) => a - b));
    // Nothing ran unattended, so there is no headline even though approvals wait.
    expect(d).toMatchObject({ unseen: false, headline: null });
  });

  it('says how each goal ended; runs of deleted cadences, other projects and missing goals do no harm', async () => {
    const m = await make({ project: makeRepo('site') });
    const shelf = m.project!.shelf;
    const make1 = (name: string, s = shelf) =>
      brain.cadences.create({ shelf: s, name, when: { type: 'interval', everyMinutes: 7 * 24 * 60 }, goal: 'Do it', budgetTokens: 10_000, autonomy: 'run', enabled: false, nextRunAt: null });
    const goalOf = (cadenceId: string, title: string) => {
      const g = brain.goals.create({ title, text: title, shelf, cadenceId });
      brain.cadences.recordRun({ cadenceId, reason: 'schedule', outcome: 'started', goalId: g.id, message: `Started "${title}".` });
      return g;
    };
    await tick();
    const a = make1('Nightly');
    const merged = goalOf(a.id, 'Merged one');
    brain.goals.setStatus(merged.id, 'running');
    const merge = brain.approvals.create({ goalId: merged.id, kind: 'merge', title: 'Merge', from: 'Inspector', whyItNeedsYou: 'w', ifYouSayYes: 'y', payload: { action: 'merge-goal', goalId: merged.id } });
    brain.approvals.decide(merge.id, 'approved', { type: 'user' });
    brain.goals.setStatus(merged.id, 'done');
    brain.goals.addSpend(merged.id, 1_000, 0);
    const stuck = goalOf(a.id, 'Stuck one');
    brain.goals.setStatus(stuck.id, 'stuck');
    const denied = goalOf(a.id, 'Denied one');
    brain.goals.setStatus(denied.id, 'awaiting_approval');
    const plan = brain.approvals.create({ goalId: denied.id, kind: 'plan', title: 'Plan', from: 'Queen', whyItNeedsYou: 'w', ifYouSayYes: 'y' });
    brain.approvals.decide(plan.id, 'denied', { type: 'user' });
    brain.goals.setStatus(denied.id, 'cancelled');
    brain.cadences.recordRun({ cadenceId: a.id, reason: 'event', outcome: 'started', goalId: 'G-missing', message: 'Its goal is gone.' });
    brain.cadences.recordRun({ cadenceId: a.id, reason: 'webhook', outcome: 'refused', message: 'Wrong secret.' });

    const gone = make1('Deleted later');
    goalOf(gone.id, 'Orphan');
    brain.cadences.delete(gone.id);
    const elsewhere = make1('Other project', 'other-project');
    brain.cadences.recordRun({ cadenceId: elsewhere.id, reason: 'schedule', outcome: 'failed', message: 'Elsewhere.' });

    const d = digest(m);
    expect(d.cadences.map((c) => c.name)).toEqual(['Nightly']);
    const c = d.cadences[0]!;
    expect(c.outcomes).toEqual({ started: 4, refused: 1 });
    expect(Object.fromEntries(c.goals.map((g) => [g.title, [g.outcome, g.waitingFor]]))).toEqual({
      'Merged one': ['Done and merged.', null],
      'Stuck one': ['Stuck: the Queen needs to re-plan it with you.', null],
      'Denied one': ['Cancelled: you said no to its plan.', null],
    });
    // Failures first, then the newest.
    expect(c.lines[0]).toMatchObject({ outcome: 'refused', message: 'Wrong secret.' });
    expect(c.lines).toHaveLength(5);
    expect(d.totals).toMatchObject({ runs: 4, goalsDone: 1, goalsFailed: 2, goalsOpen: 0, problems: 1, tokens: 1_000, costUsd: 0 });
    expect(d.unseen).toBe(true);
    expect(d.headline).toBe('While you were away: 4 runs, 1 done, 1 stuck, 1 cancelled, 1 webhook call turned away. 1,000 tokens.');
  });
});
