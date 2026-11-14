import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, type Goal, openBrain } from '@insectoids/brain';
import { demoEngine } from '@insectoids/harness';
import { type CadenceInput, CadenceInputSchema, type HiveSnapshot, HiveSnapshotSchema } from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HiveManager } from '../brain-host/hive-manager';
import { SAMPLE_GOAL_TEXT } from './practice-project';

/**
 * File and event cadences (Phase 3 A3): runs start when files change in a project folder, or when something
 * happens in the hive. Real temp folders and fs.watch; changes settle for SETTLE ms here.
 */
const libraryDir = fileURLToPath(new URL('../../../../library', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const SETTLE = 150;
/** The demo Queen plans the sample goal as one wave (it starts without asking at 'small-plans'). */
const ONE_WAVE = SAMPLE_GOAL_TEXT;

let root: string;
let repo: string;
let brain: Brain;
let managers: HiveManager[];

function makeRepo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'greet.js'), 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n');
  mkdirSync(join(dir, 'inbox'));
  writeFileSync(join(dir, 'inbox', '.keep'), '');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-cadence-triggers-'));
  repo = makeRepo('project');
  brain = openBrain(':memory:');
  managers = [];
});

afterEach(async () => {
  for (const m of managers) await m.dispose();
  await new Promise((r) => setTimeout(r, 50));
  brain.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function make(): Promise<HiveManager> {
  const m = new HiveManager({
    brain,
    tokens: null,
    doors: null,
    userDataDir: join(root, 'userData'),
    libraryDir,
    engine: 'fake',
    engineOverride: demoEngine({ queenMs: 5, insectMs: 20, inspectorMs: 5 }),
    project: repo,
    push: () => {},
    tickMs: 20,
    seed: 1,
    geminiDetect: async () => ({ status: 'missing' }),
    cadence: { intervalUnitMs: 20, recheckMs: 50, settleMs: SETTLE },
  });
  managers.push(m);
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const snap = (m: HiveManager): HiveSnapshot => HiveSnapshotSchema.parse(m.snapshot());
const input = (o: Partial<CadenceInput>) => CadenceInputSchema.parse({ name: 'Sort the inbox', when: { type: 'file', folder: 'inbox' }, goal: ONE_WAVE, budgetTokens: 40_000, autonomy: 'small-plans', ...o });
const create = async (m: HiveManager, o: Partial<CadenceInput>): Promise<string> => {
  expect(await m.command({ type: 'createCadence', cadence: input(o) })).toEqual({ ok: true });
  return snap(m).cadences.find((c) => c.name === (o.name ?? 'Sort the inbox'))!.id;
};
const goalsOf = (id: string): Goal[] => brain.goals.list().filter((g) => g.cadenceId === id);

/**
 * Answers a goal's merge once it waits, so the goal finishes (status done, the 'goal-done' event). Declines by
 * default: the demo goals all edit the same file, so a second merge into main would conflict.
 */
async function finish(m: HiveManager, goalId: string, merge = false): Promise<void> {
  const a = await until('the merge waits', () => brain.approvals.list({ status: 'waiting' }).find((x) => x.goalId === goalId && x.kind === 'merge'));
  expect(await m.command({ type: merge ? 'approve' : 'deny', approvalId: a.id })).toEqual({ ok: true });
  await until('the goal is done', () => brain.goals.get(goalId)?.status === 'done');
}

describe('file cadences (A3)', () => {
  it('two files written together start ONE run that lists both', async () => {
    const m = await make();
    const id = await create(m, { when: { type: 'file', folder: 'inbox', pattern: '*.md' } });
    expect(snap(m).cadences[0]).toMatchObject({ whenText: 'When files change in inbox (*.md)', nextRunAt: null });
    await sleep(100); // the watcher is armed
    writeFileSync(join(repo, 'inbox', 'a.md'), '# A\n');
    writeFileSync(join(repo, 'inbox', 'b.md'), '# B\n');
    const goal = await until('the run', () => goalsOf(id)[0]);
    expect(goal.text).toContain('What triggered this run:');
    expect(goal.text).toContain('2 files were added or changed:');
    expect(goal.text).toContain('- inbox/a.md');
    expect(goal.text).toContain('- inbox/b.md');
    const run = await until('the run in the log', () => m.cadenceRuns({ cadenceId: id })[0]);
    expect(run).toMatchObject({ reason: 'file', outcome: 'started', goalId: goal.id });
    await sleep(SETTLE * 3);
    expect(goalsOf(id)).toHaveLength(1);
  });

  it('non-matching and deleted files never trigger', async () => {
    writeFileSync(join(repo, 'inbox', 'old.md'), 'old\n');
    const m = await make();
    const id = await create(m, { when: { type: 'file', folder: 'inbox', pattern: '*.md' } });
    await sleep(100);
    writeFileSync(join(repo, 'inbox', 'notes.txt'), 'not markdown\n');
    unlinkSync(join(repo, 'inbox', 'old.md'));
    mkdirSync(join(repo, 'inbox', 'sub.md'));
    await sleep(SETTLE * 4);
    expect(goalsOf(id)).toHaveLength(0);
    expect(m.cadenceRuns({ cadenceId: id })).toHaveLength(0);
    // A matching file in a subfolder does.
    writeFileSync(join(repo, 'inbox', 'sub.md', 'deep.md'), 'deep\n');
    const goal = await until('the run', () => goalsOf(id)[0]);
    expect(goal.text).toContain('- inbox/sub.md/deep.md');
  });

  it('a folder that does not exist is refused; one that disappears later is reported once and watched again when back', async () => {
    const m = await make();
    expect(await m.command({ type: 'createCadence', cadence: input({ when: { type: 'file', folder: 'nope' } }) })).toEqual({
      ok: false,
      error: expect.stringMatching(/no folder "nope" in this project/),
    });
    expect(await m.command({ type: 'createCadence', cadence: { ...input({}), when: { type: 'file', folder: '../outside', pattern: null } } })).toMatchObject({ ok: false });
    mkdirSync(join(repo, 'drop'));
    const id = await create(m, { name: 'Drop box', when: { type: 'file', folder: 'drop' } });
    await sleep(100);
    rmSync(join(repo, 'drop'), { recursive: true, force: true });
    const failed = await until('the gone folder is reported', () => m.cadenceRuns({ cadenceId: id }).find((r) => r.outcome === 'failed'));
    expect(failed.message).toMatch(/folder "drop" is gone/);
    await sleep(200);
    expect(m.cadenceRuns({ cadenceId: id }).filter((r) => r.outcome === 'failed')).toHaveLength(1);
    // Back again: watching resumes on the next check.
    mkdirSync(join(repo, 'drop'));
    await sleep(300);
    writeFileSync(join(repo, 'drop', 'x.csv'), '1,2\n');
    await until('a run after the folder came back', () => goalsOf(id)[0]);
  });

  it('files that change while the hive is paused run once on resume, with everything gathered', async () => {
    const m = await make();
    const id = await create(m, {});
    await sleep(100);
    expect(await m.command({ type: 'pause', reason: 'Lunch.' })).toEqual({ ok: true });
    writeFileSync(join(repo, 'inbox', 'one.txt'), '1\n');
    await until('deferred', () => m.cadenceRuns({ cadenceId: id }).find((r) => r.outcome === 'deferred'));
    writeFileSync(join(repo, 'inbox', 'two.txt'), '2\n');
    await sleep(SETTLE * 3);
    expect(goalsOf(id)).toHaveLength(0);
    expect(m.cadenceRuns({ cadenceId: id }).map((r) => r.outcome)).toEqual(['deferred']);
    expect(snap(m).cadences[0]!.pending).toBe(true);
    expect(await m.command({ type: 'resume' })).toEqual({ ok: true });
    const goal = await until('the owed run', () => goalsOf(id)[0]);
    expect(goal.text).toContain('- inbox/one.txt');
    expect(goal.text).toContain('- inbox/two.txt');
    expect(snap(m).cadences[0]!.pending).toBe(false);
  });

  it('switching it off stops watching; run now works and says so', async () => {
    const m = await make();
    const id = await create(m, {});
    expect(await m.command({ type: 'setCadenceEnabled', id, enabled: false })).toEqual({ ok: true });
    await sleep(100);
    writeFileSync(join(repo, 'inbox', 'ignored.txt'), 'x\n');
    await sleep(SETTLE * 3);
    expect(goalsOf(id)).toHaveLength(0);
    expect(await m.command({ type: 'runCadenceNow', id })).toEqual({ ok: true });
    const goal = await until('the manual run', () => goalsOf(id)[0]);
    expect(goal.text).toContain('What triggered this run:\nYou ran it now.');
  });
});

describe('hive-event cadences (A3)', () => {
  it("goal-done after a cadence's goal starts the follow-up; the follow-up's own end triggers nothing", async () => {
    const m = await make();
    const report = await create(m, { name: 'Weekly report', when: { type: 'interval', everyMinutes: 15 }, autonomy: 'run' });
    const follow = await create(m, { name: 'Post a summary', when: { type: 'event', on: 'goal-done', cadenceId: report }, autonomy: 'run' });
    expect(snap(m).cadences.find((c) => c.id === follow)).toMatchObject({ whenText: 'After each run of "Weekly report" finishes', nextRunAt: null });
    // A goal the user gives doesn't match a follow-up chained to "Weekly report".
    expect(await m.command({ type: 'submitGoal', text: ONE_WAVE })).toEqual({ ok: true });
    const mine = await until('the user goal', () => brain.goals.list().find((g) => g.cadenceId === null));
    await finish(m, mine.id);

    const first = await until('the report run', () => goalsOf(report)[0]);
    expect(await m.command({ type: 'setCadenceEnabled', id: report, enabled: false })).toEqual({ ok: true });
    expect(goalsOf(follow)).toHaveLength(0);
    await finish(m, first.id, true);
    const next = await until('the follow-up', () => goalsOf(follow)[0]);
    expect(next.text).toContain(`What triggered this run:\nThe goal "Weekly report" finished and was merged into main.`);
    expect(await until('its log', () => m.cadenceRuns({ cadenceId: follow })[0])).toMatchObject({ reason: 'event', outcome: 'started', goalId: next.id });
    await finish(m, next.id);
    await sleep(300);
    expect(goalsOf(follow)).toHaveLength(1);
  });

  it('a follow-up of any goal never triggers on its own goals or on other event cadences (loop guard)', async () => {
    const m = await make();
    const a = await create(m, { name: 'After any goal A', when: { type: 'event', on: 'goal-done' }, autonomy: 'run' });
    const b = await create(m, { name: 'After any goal B', when: { type: 'event', on: 'goal-done' }, autonomy: 'run' });
    expect(await m.command({ type: 'submitGoal', text: ONE_WAVE })).toEqual({ ok: true });
    const mine = await until('the user goal', () => brain.goals.list().find((g) => g.cadenceId === null));
    await finish(m, mine.id);
    const ga = await until('A runs', () => goalsOf(a)[0]);
    const gb = await until('B runs', () => goalsOf(b)[0]);
    await finish(m, ga.id);
    await finish(m, gb.id);
    await sleep(300);
    expect(goalsOf(a)).toHaveLength(1);
    expect(goalsOf(b)).toHaveLength(1);
  });

  it('refuses a follow-up of itself, of a missing cadence, or of another event cadence', async () => {
    const m = await make();
    const any = await create(m, { name: 'After any goal', when: { type: 'event', on: 'goal-done' } });
    const err = async (cmd: Parameters<HiveManager['command']>[0]) => {
      const r = await m.command(cmd);
      expect(r.ok).toBe(false);
      return r.ok ? '' : r.error;
    };
    expect(await err({ type: 'updateCadence', id: any, cadence: input({ name: 'After any goal', when: { type: 'event', on: 'goal-done', cadenceId: any } }) })).toMatch(/can't run after its own runs/);
    expect(await err({ type: 'createCadence', cadence: input({ name: 'X', when: { type: 'event', on: 'goal-done', cadenceId: 'C-missing' } }) })).toMatch(/No such cadence/);
    expect(await err({ type: 'createCadence', cadence: input({ name: 'Y', when: { type: 'event', on: 'goal-done', cadenceId: any } }) })).toMatch(/waits for a hive event/);
  });

  it('budget-warning fires once per goal', async () => {
    const m = await make();
    const watch = await create(m, { name: 'Cost report', when: { type: 'event', on: 'budget-warning' }, autonomy: 'run', budgetTokens: 1_000_000 });
    expect(snap(m).cadences[0]).toMatchObject({ whenText: 'When a goal has used 75% of its budget' });
    expect(await m.command({ type: 'submitGoal', text: ONE_WAVE, budgetTokens: 1 })).toEqual({ ok: true });
    const tight = await until('the tight goal', () => brain.goals.list().find((g) => g.cadenceId === null));
    const run = await until('the report runs', () => goalsOf(watch)[0]);
    expect(run.text).toContain(`The goal "${tight.title}" has used`);
    expect(snap(m).activity.filter((x) => x.type === 'budget-warning' && x.goalId === tight.id)).toHaveLength(1);
    await sleep(400);
    expect(goalsOf(watch)).toHaveLength(1);
    expect(snap(m).activity.filter((x) => x.type === 'budget-warning' && x.goalId === tight.id)).toHaveLength(1);
  });
});
