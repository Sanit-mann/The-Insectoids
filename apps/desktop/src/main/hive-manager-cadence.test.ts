import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { demoEngine } from '@insectoids/harness';
import { type CadenceInput, CadenceInputSchema, type HiveSnapshot, HiveSnapshotSchema } from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HiveManager } from '../brain-host/hive-manager';
import { SAMPLE_GOAL_TEXT } from './practice-project';

/**
 * Cadences in the host (Phase 3 A1): the scheduler runs next to the hive; every run is a goal for the Queen.
 * Interval "minutes" are 20 ms here, so the 15-minute minimum fires after 300 ms.
 */
const libraryDir = fileURLToPath(new URL('../../../../library', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const UNIT = 20;
const DAY = 86_400_000;
/** The demo Queen plans the sample goal as one wave; any other goal as two waves. */
const ONE_WAVE = SAMPLE_GOAL_TEXT;
const TWO_WAVES = 'Write the weekly status report';

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
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-cadence-hm-'));
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

async function make(project = repo): Promise<HiveManager> {
  const m = new HiveManager({
    brain,
    tokens: null,
    doors: null,
    userDataDir: join(root, 'userData'),
    libraryDir,
    engine: 'fake',
    engineOverride: demoEngine({ queenMs: 5, insectMs: 20, inspectorMs: 5 }),
    project,
    push: () => {},
    tickMs: 20,
    seed: 1,
    geminiDetect: async () => ({ status: 'missing' }),
    cadence: { intervalUnitMs: UNIT, recheckMs: 25 },
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

const snap = (m: HiveManager): HiveSnapshot => HiveSnapshotSchema.parse(m.snapshot());
const cadence = (o: Partial<CadenceInput> = {}) => CadenceInputSchema.parse({ name: 'Weekly report', when: { type: 'interval', everyMinutes: 15 }, goal: ONE_WAVE, budgetTokens: 40_000, autonomy: 'small-plans', ...o });
const ok = async (m: HiveManager, cmd: Parameters<HiveManager['command']>[0]) => expect(await m.command(cmd)).toEqual({ ok: true });
const goalsOf = (id: string) => brain.goals.list().filter((g) => g.cadenceId === id);

describe('schedules (Cadence 05; Phase 3 A1)', () => {
  it('a due cadence starts a goal for the Queen with its budget, and the goal remembers it', async () => {
    const m = await make();
    await ok(m, { type: 'createCadence', cadence: cadence() });
    const view = snap(m).cadences[0]!;
    expect(view).toMatchObject({ name: 'Weekly report', whenText: 'Every 15 minutes', enabled: true, pending: false, autonomy: 'small-plans', budgetTokens: 40_000, lastRun: null });
    expect(view.nextRunAt).toBeGreaterThan(Date.now() - 1_000);

    const goal = await until('the cadence starts a goal', () => goalsOf(view.id)[0]);
    expect(goal).toMatchObject({ title: 'Weekly report', budgetTokens: 40_000, text: ONE_WAVE });
    const after = snap(m);
    expect(after.goals.find((g) => g.id === goal.id)?.cadenceId).toBe(view.id);
    expect(after.cadences[0]!.lastRun).toMatchObject({ reason: 'schedule', outcome: 'started', goalId: goal.id });
    expect(after.activity.some((a) => a.type === 'cadence' && /"Weekly report" started a run \(on schedule\)/.test(a.message))).toBe(true);
    // One wave, 'small-plans': it starts without asking; its merge into main still waits for the user, as always.
    await until('the merge waits', () => brain.approvals.list({ status: 'waiting' }).some((a) => a.goalId === goal.id && a.kind === 'merge'));
    expect(brain.approvals.list().filter((a) => a.goalId === goal.id && a.kind === 'plan')).toHaveLength(0);
    // Until then the goal counts as still going, so the next due time is skipped, saying what it waits for.
    const skipped = await until('a skipped run', () => m.cadenceRuns({ cadenceId: view.id }).find((r) => r.outcome === 'skipped' && /approve its merge/.test(r.message)));
    expect(skipped.goalId).toBe(goal.id);
    const runs = m.cadenceRuns({ cadenceId: view.id });
    expect(runs[runs.length - 1]).toMatchObject({ outcome: 'started', goalId: goal.id });
    expect(goalsOf(view.id)).toHaveLength(1);
  });

  it("'ask': the plan waits; the next due time is skipped instead of piling up", async () => {
    const m = await make();
    await ok(m, { type: 'createCadence', cadence: cadence({ autonomy: 'ask' }) });
    const id = snap(m).cadences[0]!.id;
    const goal = await until('the first run', () => goalsOf(id)[0]);
    await until('the plan waits', () => brain.goals.get(goal.id)?.status === 'awaiting_approval');
    expect(brain.approvals.list({ status: 'waiting' }).find((a) => a.goalId === goal.id)?.whyItNeedsYou).toMatch(/cadence "Weekly report" is set to ask before every plan/);
    const skipped = await until('a skipped run', () => m.cadenceRuns({ cadenceId: id }).find((r) => r.outcome === 'skipped'));
    expect(skipped).toMatchObject({ goalId: goal.id, reason: 'schedule' });
    expect(skipped.message).toMatch(/is still going/);
    expect(goalsOf(id)).toHaveLength(1);
  });

  it("'run': even a two-wave plan starts without asking", async () => {
    const m = await make();
    await ok(m, { type: 'createCadence', cadence: cadence({ goal: TWO_WAVES, autonomy: 'run' }) });
    const id = snap(m).cadences[0]!.id;
    const goal = await until('the run', () => goalsOf(id)[0]);
    await until('it runs', () => brain.goals.get(goal.id)?.status === 'running' || brain.goals.get(goal.id)?.status === 'done');
    expect(brain.approvals.list().filter((a) => a.goalId === goal.id && a.kind === 'plan')).toHaveLength(0);
  });

  it('while the hive is paused a due run is owed once, and runs once on resume', async () => {
    const m = await make();
    await ok(m, { type: 'pause', reason: 'Lunch.' });
    await ok(m, { type: 'createCadence', cadence: cadence() });
    const id = snap(m).cadences[0]!.id;
    await until('owed', () => snap(m).cadences[0]!.pending);
    // Several due times pass while paused: still one record, no goal.
    await new Promise((r) => setTimeout(r, 15 * UNIT * 3));
    expect(m.cadenceRuns({ cadenceId: id }).map((r) => r.outcome)).toEqual(['deferred']);
    expect(m.cadenceRuns({ cadenceId: id })[0]!.message).toMatch(/The hive is paused \(Lunch\.\)/);
    expect(goalsOf(id)).toHaveLength(0);
    await expect(m.command({ type: 'runCadenceNow', id })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/paused/) });

    await ok(m, { type: 'resume' });
    const goal = await until('the owed run', () => goalsOf(id)[0]);
    expect(m.cadenceRuns({ cadenceId: id }).find((r) => r.goalId === goal.id)).toMatchObject({ reason: 'catch-up', outcome: 'started' });
    expect(snap(m).cadences[0]!.pending).toBe(false);
  });

  it('after a long gap (app closed) it catches up once, and keeps its rhythm', async () => {
    const first = await make();
    const shelf = first.project!.shelf;
    await first.dispose();
    const now = Date.now();
    const c = brain.cadences.create({
      shelf,
      name: 'Nightly tidy',
      when: { type: 'interval', everyMinutes: 60 * 24 * 7 },
      goal: ONE_WAVE,
      budgetTokens: 30_000,
      autonomy: 'small-plans',
      enabled: true,
      nextRunAt: now - 3 * DAY,
    });
    const m = await make();
    const goal = await until('the catch-up run', () => goalsOf(c.id)[0]);
    const run = m.cadenceRuns({ cadenceId: c.id })[0]!;
    expect(run).toMatchObject({ reason: 'catch-up', outcome: 'started', goalId: goal.id });
    expect(goalsOf(c.id)).toHaveLength(1);
    // Next time stays on the schedule's own phase (a week of 20 ms "minutes" ≈ 3.4 min after the missed one).
    expect(snap(m).cadences[0]!.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("another project's cadence waits while its project is closed, then catches up once when it opens", async () => {
    const other = makeRepo('other');
    const m = await make(other);
    const otherShelf = m.project!.shelf;
    await ok(m, { type: 'setProject', path: repo });
    const c = brain.cadences.create({
      shelf: otherShelf,
      name: 'Other report',
      when: { type: 'interval', everyMinutes: 15 },
      goal: ONE_WAVE,
      budgetTokens: 30_000,
      autonomy: 'small-plans',
      enabled: true,
      nextRunAt: Date.now() - 1_000,
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(goalsOf(c.id)).toHaveLength(0);
    expect(snap(m).cadences).toHaveLength(0);
    await ok(m, { type: 'setProject', path: other });
    const goal = await until('it runs once its project is open', () => goalsOf(c.id)[0]);
    expect(goal.shelf).toBe(otherShelf);
  });

  it('run now, switch off, edit and delete', async () => {
    const m = await make();
    await ok(m, { type: 'createCadence', cadence: cadence({ when: { type: 'weekly', days: [1, 4], time: '09:00' }, autonomy: 'ask' }) });
    const id = snap(m).cadences[0]!.id;
    expect(snap(m).cadences[0]!.whenText).toBe('Every Monday and Thursday at 09:00');

    await ok(m, { type: 'runCadenceNow', id });
    expect(m.cadenceRuns({ cadenceId: id })[0]).toMatchObject({ reason: 'manual', outcome: 'started' });
    // The last run is still going (its plan waits): a second "run now" says so.
    await until('the plan waits', () => goalsOf(id)[0]?.status === 'awaiting_approval');
    expect(await m.command({ type: 'runCadenceNow', id })).toMatchObject({ ok: false, error: expect.stringMatching(/still going/) });

    await ok(m, { type: 'setCadenceEnabled', id, enabled: false });
    expect(snap(m).cadences[0]).toMatchObject({ enabled: false, nextRunAt: null });
    await ok(m, { type: 'updateCadence', id, cadence: cadence({ name: 'Renamed', enabled: true }) });
    expect(snap(m).cadences[0]).toMatchObject({ name: 'Renamed', enabled: true, whenText: 'Every 15 minutes' });

    await ok(m, { type: 'deleteCadence', id });
    expect(snap(m).cadences).toHaveLength(0);
    expect(m.cadenceRuns({ cadenceId: id }).length).toBeGreaterThan(0);
    expect(await m.command({ type: 'deleteCadence', id })).toMatchObject({ ok: false, error: expect.stringMatching(/No such cadence/) });
  });

  it('cadences belong to a project', async () => {
    const m = new HiveManager({
      brain, tokens: null, doors: null, userDataDir: join(root, 'userData-none'), libraryDir, engine: 'fake',
      engineOverride: demoEngine({ queenMs: 5, insectMs: 20, inspectorMs: 5 }), push: () => {}, tickMs: 20, seed: 1,
      geminiDetect: async () => ({ status: 'missing' }), cadence: { intervalUnitMs: UNIT, recheckMs: 25 },
    });
    managers.push(m);
    await m.init();
    expect(await m.command({ type: 'createCadence', cadence: cadence() })).toMatchObject({ ok: false, error: expect.stringMatching(/Pick a project folder first/) });
  });
});
