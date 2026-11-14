import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { demoEngine } from '@insectoids/harness';
import {
  BACKUP_FILE_PATTERN,
  type CadenceInput,
  CadenceInputSchema,
  type HiveSnapshot,
  HiveSnapshotSchema,
  MAINTENANCE_JOBS,
  MAINTENANCE_JOB_ORDER,
  maintenanceCadenceId,
} from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HiveManager } from '../brain-host/hive-manager';

/**
 * Built-in maintenance jobs in the host (Cadence 05-D7; Phase 3 A5): code, not goals, on the Global shelf, run with
 * or without a project. Interval "minutes" are 20 ms here, so a 15-minute schedule fires after 300 ms.
 */
const libraryDir = fileURLToPath(new URL('../../../../library', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const UNIT = 20;
const HOUR = 3_600_000;
const ant = { type: 'agent', id: 'Ant-1' } as const;

let root: string;
let brain: Brain;
/** Added to the real clock (Brain and host alike), to make goals look a day old. */
let shift: number;
let managers: HiveManager[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-maint-hm-'));
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
  writeFileSync(join(dir, 'README.md'), '# Site\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** No project unless one is given: the jobs don't need one. */
function create(o: { project?: string; shiftDays?: number } = {}): HiveManager {
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
    ...(o.shiftDays ? { tidy: { clockShiftDays: o.shiftDays } } : {}),
  });
  managers.push(m);
  return m;
}

async function make(o: { project?: string; shiftDays?: number } = {}): Promise<HiveManager> {
  const m = create(o);
  await m.init();
  return m;
}

async function until<T>(what: string, read: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const snap = (m: HiveManager): HiveSnapshot => HiveSnapshotSchema.parse(m.snapshot());
const ok = async (m: HiveManager, cmd: Parameters<HiveManager['command']>[0]) => expect(await m.command(cmd)).toEqual({ ok: true });
const job = (m: HiveManager, id: string) => snap(m).cadences.find((c) => c.id === id)!;
const lastRun = (m: HiveManager, id: string) => m.cadenceRuns({ cadenceId: id })[0];
const input = (o: Partial<CadenceInput>) => CadenceInputSchema.parse({ name: 'x', when: { type: 'interval', everyMinutes: 60 }, goal: 'Do the thing', ...o });

describe('built-in jobs (Cadence 05-D7; Phase 3 A5)', () => {
  it('are made once, switched on, with their names and default schedules, and listed without a project', async () => {
    const m = await make();
    expect(m.project).toBeNull();
    const built = snap(m).cadences.filter((c) => c.builtIn);
    expect(built.map((c) => c.id)).toEqual(MAINTENANCE_JOB_ORDER.map(maintenanceCadenceId));
    for (const c of built) {
      const spec = MAINTENANCE_JOBS[c.when.type === 'maintenance' ? c.when.job : 'backup'];
      expect(c).toMatchObject({ shelf: 'global', name: spec.name, goal: spec.sentence, enabled: true, when: { type: 'maintenance', schedule: spec.schedule } });
      expect(c.nextRunAt).toBeGreaterThan(Date.now() - 1_000);
    }
    expect(job(m, 'maint-brain-audit').whenText).toBe('Every 6 hours');
    // A second start keeps them as they are (one each).
    await ok(m, { type: 'setCadenceEnabled', id: 'maint-backup', enabled: false });
    const again = await make();
    expect(snap(again).cadences.filter((c) => c.builtIn)).toHaveLength(5);
    expect(brain.cadences.list('global')).toHaveLength(5);
    expect(job(again, 'maint-backup').enabled).toBe(false);
  });

  it("a user can't make one, rename one or remove one: delete switches it off", async () => {
    const m = await make({ project: makeRepo('site') });
    const made = await m.command({ type: 'createCadence', cadence: input({ when: { type: 'maintenance', job: 'backup', schedule: { type: 'interval', everyMinutes: 60 } } }) });
    expect(made).toMatchObject({ ok: false, error: expect.stringMatching(/Built-in jobs can't be made by hand/) });
    expect(brain.cadences.list('global')).toHaveLength(5);

    await ok(m, { type: 'deleteCadence', id: 'maint-skill-review' });
    expect(job(m, 'maint-skill-review')).toMatchObject({ enabled: false, nextRunAt: null, builtIn: true });
    expect(snap(m).activity.some((a) => a.message.includes("Built-in jobs can't be removed, so it's switched off. Switch it on again any time."))).toBe(true);
    await ok(m, { type: 'setCadenceEnabled', id: 'maint-skill-review', enabled: true });
    expect(job(m, 'maint-skill-review').nextRunAt).not.toBeNull();
  });

  it('a schedule edit is kept; the job, name and sentence stay', async () => {
    const m = await make();
    await ok(m, { type: 'updateCadence', id: 'maint-consolidate', cadence: input({ name: 'Renamed', goal: 'Something else', when: { type: 'interval', everyMinutes: 120 } }) });
    expect(job(m, 'maint-consolidate')).toMatchObject({
      name: 'Tidy the Brain',
      goal: MAINTENANCE_JOBS.consolidate.sentence,
      when: { type: 'maintenance', job: 'consolidate', schedule: { type: 'interval', everyMinutes: 120 } },
      whenText: 'Every 2 hours',
    });
    await ok(m, { type: 'updateCadence', id: 'maint-backup', cadence: input({ when: { type: 'maintenance', job: 'backup', schedule: { type: 'weekly', days: [1], time: '02:30' } } }) });
    expect(job(m, 'maint-backup').whenText).toBe('Every Monday at 02:30');
    const other = await m.command({ type: 'updateCadence', id: 'maint-backup', cadence: input({ when: { type: 'maintenance', job: 'consolidate', schedule: { type: 'interval', everyMinutes: 60 } } }) });
    expect(other).toMatchObject({ ok: false, error: expect.stringMatching(/another one/) });
    const file = await m.command({ type: 'updateCadence', id: 'maint-backup', cadence: input({ when: { type: 'file', folder: 'inbox', pattern: null } }) });
    expect(file).toMatchObject({ ok: false, error: expect.stringMatching(/runs on a schedule/) });
  });

  it('each job logs done with what it did, in plain words', async () => {
    const m = await make();
    m.setBackupDir(join(root, 'backups'));
    // Two agent notes that became near-duplicates through edits (writes fold them at once), and one old note.
    brain.write({ kind: 'update', shelf: 'global', title: 'Checkout notes', body: 'The checkout page uses Stripe Elements for card entry.' }, ant);
    const y = brain.write({ kind: 'update', shelf: 'global', title: 'Deploy notes', body: 'Deploys go out on Fridays.' }, ant).id;
    brain.update(y, { title: 'Checkout notes', body: 'the checkout page uses stripe elements, for card entry' }, ant);

    for (const j of MAINTENANCE_JOB_ORDER) await ok(m, { type: 'runCadenceNow', id: maintenanceCadenceId(j) });
    const says = (j: (typeof MAINTENANCE_JOB_ORDER)[number]) => lastRun(m, maintenanceCadenceId(j));
    expect(says('brain-audit')).toMatchObject({ reason: 'manual', outcome: 'done', goalId: null, message: expect.stringMatching(/^Brain health \d+\/100\. /) });
    expect(says('backup')).toMatchObject({ outcome: 'done', message: expect.stringMatching(/^Backed up the Brain \(\d+(\.\d)? (KB|MB|bytes)\)\. 1 copy kept\.$/) });
    expect(says('consolidate')).toMatchObject({ outcome: 'done', message: 'Faded 0 unused agent notes. Folded 1 agent-only near-duplicate.' });
    expect(says('stale-tasks')).toMatchObject({ outcome: 'done', message: 'No stale cards.' });
    expect(says('skill-review')).toMatchObject({ outcome: 'done', message: 'No skills to retire.' });
    expect(job(m, 'maint-backup').lastRun).toMatchObject({ outcome: 'done' });
    // Jobs are code: no goal was made.
    expect(brain.goals.list()).toHaveLength(0);
  });

  it('jobs run on their schedule with no project open, and while the hive is paused', async () => {
    const m = await make();
    await ok(m, { type: 'pause' });
    await ok(m, { type: 'updateCadence', id: 'maint-stale-tasks', cadence: input({ when: { type: 'interval', everyMinutes: 15 } }) });
    const run = await until('a scheduled run', () => lastRun(m, 'maint-stale-tasks'));
    expect(run).toMatchObject({ reason: 'schedule', outcome: 'done', message: 'No stale cards.' });
  });
});

describe('backup', () => {
  it('without a folder it fails in words', async () => {
    const m = await make();
    expect(await m.command({ type: 'runCadenceNow', id: 'maint-backup' })).toEqual({ ok: false, error: 'No backups folder yet.' });
    expect(lastRun(m, 'maint-backup')).toMatchObject({ outcome: 'failed', message: 'No backups folder yet.' });
    expect(() => m.setBackupDir('relative/folder')).toThrow(/full path/);
  });

  it('writes a copy that opens as a Brain with the same records, keeps the newest 7 and leaves other files alone', async () => {
    const m = await make();
    const dir = join(root, 'my backups');
    mkdirSync(dir);
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    writeFileSync(join(dir, 'brain-backup-keep-me.db'), 'not a stamped name');
    m.setBackupDir(dir);
    const rec = brain.write({ kind: 'decision', shelf: 'global', title: 'Back up nightly', body: 'Keep a week of copies.' }, { type: 'user' }).id;
    for (let i = 0; i < 9; i++) {
      await ok(m, { type: 'runCadenceNow', id: 'maint-backup' });
      shift += 24 * HOUR;
    }
    const copies = readdirSync(dir).filter((n) => BACKUP_FILE_PATTERN.test(n)).sort();
    expect(copies).toHaveLength(7);
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
    expect(existsSync(join(dir, 'brain-backup-keep-me.db'))).toBe(true);
    expect(lastRun(m, 'maint-backup')!.message).toMatch(/7 copies kept\. Removed 1 older copy\.$/);
    const copy = openBrain(join(dir, copies.at(-1)!));
    try {
      expect(copy.get(rec)).toMatchObject({ title: 'Back up nightly', trust: 'confirmed' });
      expect(copy.cadences.get('maint-backup')).toMatchObject({ name: 'Daily backup' });
    } finally {
      copy.close();
    }
  });
});

describe('stale task cleanup', () => {
  const card = (id: string, goalId: string) => ({ id, goalId, wave: 1, title: `Card ${id}`, brief: 'b', caste: 'coder' as const, priority: 'normal' as const, acceptance: ['ok'], dependsOn: [] });

  it('closes open cards only after their goal ended over a day ago, and never deletes them', async () => {
    const m = await make();
    const done = brain.goals.create({ title: 'Old', text: 'Old goal', shelf: 'site' });
    brain.goals.setStatus(done.id, 'running');
    brain.goals.setStatus(done.id, 'done');
    const running = brain.goals.create({ title: 'Still going', text: 'Going', shelf: 'site' });
    brain.goals.setStatus(running.id, 'running');
    brain.taskboard.post(card(`${done.id}.C-01`, done.id));
    brain.taskboard.post(card(`${done.id}.C-02`, done.id));
    brain.taskboard.post(card(`${running.id}.C-01`, running.id));
    brain.taskboard.post(card('G-gone.C-01', 'G-gone'));

    // Ended only just now: nothing yet.
    await ok(m, { type: 'runCadenceNow', id: 'maint-stale-tasks' });
    expect(lastRun(m, 'maint-stale-tasks')!.message).toBe('No stale cards.');

    shift = 25 * HOUR;
    const fresh = brain.goals.create({ title: 'Recent', text: 'Recent', shelf: 'site' });
    brain.goals.setStatus(fresh.id, 'cancelled');
    brain.taskboard.post(card(`${fresh.id}.C-01`, fresh.id));
    await ok(m, { type: 'runCadenceNow', id: 'maint-stale-tasks' });
    expect(lastRun(m, 'maint-stale-tasks')).toMatchObject({ outcome: 'done', message: 'Closed 3 stale cards left open after their goal ended.' });
    expect(brain.taskboard.get(`${done.id}.C-01`)).toMatchObject({ status: 'failed', escalated: false });
    expect(brain.taskboard.events(`${done.id}.C-01`).at(-1)).toMatchObject({ to: 'failed', note: 'Closed by stale task cleanup: its goal ended.' });
    expect(brain.taskboard.get('G-gone.C-01')!.status).toBe('failed');
    expect(brain.taskboard.get(`${running.id}.C-01`)!.status).toBe('open');
    expect(brain.taskboard.get(`${fresh.id}.C-01`)!.status).toBe('open');
    expect(brain.taskboard.list()).toHaveLength(5);
  });
});

describe('consolidate', () => {
  it('switched off, it never fades (not at start, not on its schedule); switched on again, it does', async () => {
    const note = brain.write({ kind: 'update', shelf: 'global', title: 'Scratch', body: 'An old note nobody read.' }, ant).id;
    const m = create({ shiftDays: 90 });
    brain.cadences.setEnabled('maint-consolidate', false, null);
    await m.init();
    expect(brain.get(note)!.archived).toBe(false);
    await ok(m, { type: 'updateCadence', id: 'maint-consolidate', cadence: input({ when: { type: 'interval', everyMinutes: 15 }, enabled: false }) });
    await new Promise((r) => setTimeout(r, 500));
    expect(brain.get(note)!.archived).toBe(false);
    expect(m.cadenceRuns({ cadenceId: 'maint-consolidate' })).toHaveLength(0);

    await ok(m, { type: 'setCadenceEnabled', id: 'maint-consolidate', enabled: true });
    await until('it fades on schedule', () => brain.get(note)!.archived);
    expect(brain.get(note)!.archivedReason).toBe('faded: unused for 90 days');
    expect(lastRun(m, 'maint-consolidate')).toMatchObject({ reason: 'schedule', outcome: 'done', message: 'Faded 1 unused agent note. Folded 0 agent-only near-duplicates.' });
  });

  it('"Tidy now" still fades on demand', async () => {
    const m = await make({ shiftDays: 90 });
    const note = brain.write({ kind: 'update', shelf: 'global', title: 'Scratch', body: 'Another old note.' }, ant).id;
    await ok(m, { type: 'tidyBrain' });
    expect(brain.get(note)!.archived).toBe(true);
  });
});

describe('cadence proposals (05-D3) in the host', () => {
  const proposal = (shelf: string) =>
    brain.approvals.create({
      kind: 'schedule',
      title: 'Make a cadence for "Weekly report"?',
      from: 'Queen',
      whyItNeedsYou: 'You asked for it three times.',
      ifYouSayYes: 'A cadence runs it every Monday at 09:00.',
      payload: {
        action: 'cadence-proposal',
        key: `${shelf}|weekly report`,
        cadence: input({ name: 'Weekly report', when: { type: 'weekly', days: [1], time: '09:00' }, goal: 'Write the weekly report' }),
        shelf,
        goalIds: ['G-1'],
      },
    });

  it('a yes makes the cadence in the open project; another project must be opened first', async () => {
    const m = await make({ project: makeRepo('site') });
    const elsewhere = proposal('other-project');
    expect(await m.command({ type: 'approve', approvalId: elsewhere.id })).toEqual({ ok: false, error: 'Open the project first, then say yes again.' });
    expect(brain.approvals.get(elsewhere.id)!.status).toBe('waiting');
    const here = proposal(m.project!.shelf);
    await ok(m, { type: 'approve', approvalId: here.id });
    expect(snap(m).cadences.find((c) => !c.builtIn)).toMatchObject({ name: 'Weekly report', shelf: m.project!.shelf, enabled: true });
    await ok(m, { type: 'deny', approvalId: elsewhere.id });
    expect(brain.approvals.get(elsewhere.id)!.status).toBe('denied');
  });
});
