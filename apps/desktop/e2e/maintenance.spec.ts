import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import {
  BACKUP_FILE_PATTERN,
  BACKUP_KEEP,
  type CadenceView,
  type HiveApi,
  MAINTENANCE_JOBS,
  MAINTENANCE_JOB_ORDER,
  MAINTENANCE_SHELF,
  type MaintenanceJob,
  maintenanceCadenceId,
} from '@insectoids/shared';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * Maintenance and proposals (Phase 3 A5, Cadence 05-D3, D7; Memory 01-D8).
 *
 * - Built-in housekeeping jobs (`maint-<job>` on the Global shelf) exist from the first start, switched on, in every
 *   snapshot, with or without a project. They can be switched off (deleting one only switches it off), run now or
 *   rescheduled, but not created by hand. Jobs are code: Run now logs a `done` run with a plain-words message.
 * - Backups: the `backup` job copies the Brain into the backups folder and keeps the newest BACKUP_KEEP copies.
 *   Restore copies a backup into a new `<userData>/brain-restored-<stamp>/brain.db` and switches the Brain there;
 *   the old Brain stays where it was.
 * - Cadence proposals: the same request asked CADENCE_PROPOSAL_MIN_REPEATS times becomes a `schedule` approval;
 *   a yes creates the cadence, and the same request is not proposed again.
 *
 * Nothing here touches the Vault, so nothing skips on a Linux runner without a key store.
 */
const snapshot = (win: Page) => win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.snapshot());
const command = (win: Page, cmd: Parameters<HiveApi['command']>[0]) =>
  win.evaluate((c) => (globalThis as unknown as AppWindow).insectoids.hive.command(c), cmd);
const runsOf = (win: Page, cadenceId: string) =>
  win.evaluate((id) => (globalThis as unknown as AppWindow).insectoids.hive.cadenceRuns({ cadenceId: id, limit: 50 }), cadenceId);
const backupState = (win: Page) => win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.backups.state());
const brainState = (win: Page) => win.evaluate(async () => (await (globalThis as unknown as AppWindow).insectoids.brainStatus()).state);

async function brainReady(win: Page): Promise<void> {
  await expect.poll(() => brainState(win), { timeout: 30_000 }).toBe('ready');
}

const builtIns = async (win: Page): Promise<CadenceView[]> => (await snapshot(win)).cadences.filter((c) => c.builtIn);
const cadence = async (win: Page, id: string): Promise<CadenceView | undefined> => (await snapshot(win)).cadences.find((c) => c.id === id);

/** Checks the five built-in jobs: fixed ids, Global shelf, switched on, on their default schedules. */
async function expectFiveBuiltIns(win: Page, o: { defaultSchedules?: boolean } = {}): Promise<void> {
  const jobs = await builtIns(win);
  expect(jobs.map((c) => c.id).sort()).toEqual(MAINTENANCE_JOB_ORDER.map((j) => maintenanceCadenceId(j)).sort());
  for (const job of MAINTENANCE_JOB_ORDER) {
    const c = jobs.find((x) => x.id === maintenanceCadenceId(job))!;
    expect(c, job).toMatchObject({
      builtIn: true,
      shelf: MAINTENANCE_SHELF,
      enabled: true,
      name: MAINTENANCE_JOBS[job].name,
      when: { type: 'maintenance', job, ...(o.defaultSchedules === false ? {} : { schedule: MAINTENANCE_JOBS[job].schedule }) },
    });
    // Switched on and scheduled, so it has a next time.
    expect(typeof c.nextRunAt, job).toBe('number');
  }
}

/** Number of `done` runs a job has logged. */
const doneRuns = async (win: Page, id: string): Promise<number> => (await runsOf(win, id)).filter((r) => r.outcome === 'done').length;

/**
 * Runs the backup job now and waits for its `done` run. Backup names have one-second resolution, so this first
 * waits until the second of the previous backup has passed (two backups in one second would share a name).
 */
let lastBackupAt = 0;
async function backUpNow(win: Page): Promise<void> {
  const wait = lastBackupAt + 1_100 - Date.now();
  if (wait > 0) await win.waitForTimeout(wait);
  const id = maintenanceCadenceId('backup');
  const before = await doneRuns(win, id);
  expect(await command(win, { type: 'runCadenceNow', id })).toEqual({ ok: true });
  await expect.poll(() => doneRuns(win, id), { timeout: 20_000 }).toBe(before + 1);
  lastBackupAt = Date.now();
}

test.describe('built-in jobs, backups and restore (no project open)', () => {
  test.describe.configure({ mode: 'serial' });
  let t: LaunchedApp;

  test.beforeAll(async () => {
    t = await launchApp({ project: 'none' });
    await brainReady(t.win);
  });

  test.afterAll(async () => {
    await t?.close();
  });

  test('the five built-in jobs exist from the first start, switched on, on the Global shelf, with no project open', async () => {
    const { win } = t;
    expect((await snapshot(win)).project).toBeNull();
    await expect.poll(async () => (await builtIns(win)).length, { timeout: 15_000 }).toBe(MAINTENANCE_JOB_ORDER.length);
    await expectFiveBuiltIns(win);
  });

  test('deleting a built-in switches it off; it can be switched back on, rescheduled, but not made by hand', async () => {
    const { win } = t;
    const id = maintenanceCadenceId('skill-review');

    // Delete = switch off: still listed, still built in, no next time.
    expect(await command(win, { type: 'deleteCadence', id })).toEqual({ ok: true });
    await expect.poll(async () => (await cadence(win, id))?.enabled, { timeout: 10_000 }).toBe(false);
    const off = (await cadence(win, id))!;
    expect(off).toMatchObject({ builtIn: true, shelf: MAINTENANCE_SHELF, enabled: false, nextRunAt: null });
    expect((await builtIns(win)).length).toBe(MAINTENANCE_JOB_ORDER.length);

    // Back on.
    expect(await command(win, { type: 'setCadenceEnabled', id, enabled: true })).toEqual({ ok: true });
    await expect.poll(async () => (await cadence(win, id))?.enabled, { timeout: 10_000 }).toBe(true);
    expect(typeof (await cadence(win, id))!.nextRunAt).toBe('number');

    // A maintenance cadence can't be made by hand: refused, in words, and nothing new is listed.
    const countBefore = (await snapshot(win)).cadences.length;
    const made = await command(win, {
      type: 'createCadence',
      cadence: {
        name: 'My own backup',
        when: { type: 'maintenance', job: 'backup', schedule: { type: 'interval', everyMinutes: 60 } },
        goal: 'Back up the Brain',
        budgetTokens: 50_000,
        autonomy: 'small-plans',
        enabled: true,
      },
    });
    expect(made.ok).toBe(false);
    if (!made.ok) expect(made.error.length).toBeGreaterThan(0);
    expect((await snapshot(win)).cadences.length).toBe(countBefore);

    // Its schedule can change, and the change is kept.
    const job: MaintenanceJob = 'brain-audit';
    const auditId = maintenanceCadenceId(job);
    const audit = (await cadence(win, auditId))!;
    const fields = {
      name: audit.name,
      // Built-in jobs have no goal of their own; the command's schema still wants one, so send what it shows (or the sentence).
      goal: audit.goal.trim().length >= 3 ? audit.goal : MAINTENANCE_JOBS[job].sentence,
      budgetTokens: audit.budgetTokens,
      autonomy: audit.autonomy,
      enabled: audit.enabled,
    };
    const newSchedule = { type: 'interval' as const, everyMinutes: 120 };
    const updated = await command(win, { type: 'updateCadence', id: auditId, cadence: { ...fields, when: { type: 'maintenance', job, schedule: newSchedule } } });
    expect(updated).toEqual({ ok: true });
    await expect.poll(async () => (await cadence(win, auditId))?.when, { timeout: 10_000 }).toEqual({ type: 'maintenance', job, schedule: newSchedule });
    const after = (await cadence(win, auditId))!;
    expect(after).toMatchObject({ builtIn: true, shelf: MAINTENANCE_SHELF, name: MAINTENANCE_JOBS[job].name, enabled: true });

    // Only the schedule may change: a new name is refused or left out.
    const renamed = await command(win, {
      type: 'updateCadence',
      id: auditId,
      cadence: { ...fields, name: 'Renamed health check', when: { type: 'maintenance', job, schedule: newSchedule } },
    });
    if (renamed.ok) expect((await cadence(win, auditId))!.name).toBe(MAINTENANCE_JOBS[job].name);
    else expect(renamed.error.length).toBeGreaterThan(0);
    expect((await builtIns(win)).length).toBe(MAINTENANCE_JOB_ORDER.length);
  });

  test('Run now on the backup job logs a done run and writes one backup file', async () => {
    const { win } = t;
    const id = maintenanceCadenceId('backup');
    // A first start has no backups yet (the daily 03:00 run isn't due, and there is nothing to catch up on).
    expect((await backupState(win)).backups).toHaveLength(0);

    await backUpNow(win);
    const [run] = await runsOf(win, id);
    expect(run).toMatchObject({ cadenceId: id, reason: 'manual', outcome: 'done', goalId: null });
    // UNSURE: the exact words; the contract's example is "Backed up the Brain (2.1 MB)."
    expect(run!.message).toMatch(/backed up/i);
    // Jobs are code, not goals: nothing went to the Queen.
    expect((await snapshot(win)).goals).toHaveLength(0);

    const state = await backupState(win);
    expect(state.dir).toBe(state.defaultDir);
    expect(state.backups).toHaveLength(1);
    const [b] = state.backups;
    expect(b!.file).toMatch(BACKUP_FILE_PATTERN);
    expect(b!.sizeBytes).toBeGreaterThan(0);
    expect(existsSync(join(state.dir, b!.file))).toBe(true);
    expect(state.message.length).toBeGreaterThan(0);
  });

  test(`backing up again and again keeps only the newest ${BACKUP_KEEP} copies`, async () => {
    test.setTimeout(120_000);
    const { win } = t;
    const first = (await backupState(win)).backups.at(-1)!.file;
    // 7 more runs: 8 in all.
    for (let i = 0; i < BACKUP_KEEP; i += 1) await backUpNow(win);

    await expect.poll(async () => (await backupState(win)).backups.length, { timeout: 15_000 }).toBe(BACKUP_KEEP);
    const state = await backupState(win);
    const files = state.backups.map((x) => x.file);
    expect(new Set(files).size).toBe(BACKUP_KEEP);
    for (const f of files) expect(f).toMatch(BACKUP_FILE_PATTERN);
    // Newest first, and the oldest (the first one) is the one that went.
    expect([...files].sort().reverse()).toEqual(files);
    expect(files).not.toContain(first);
    expect(existsSync(join(state.dir, first))).toBe(false);
    expect(await doneRuns(win, maintenanceCadenceId('backup'))).toBe(BACKUP_KEEP + 1);
  });

  test('restore switches the Brain to a new folder with the backup in it; the old Brain stays', async () => {
    test.setTimeout(120_000);
    const { win, app } = t;
    const setupState = () => win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.setup.state());
    const saveAbout = (id: 'role' | 'goals', answer: string) =>
      win.evaluate(([q, a]) => (globalThis as unknown as AppWindow).insectoids.setup.saveAbout({ answers: [{ id: q, answer: a }] }), [id, answer] as const);
    /** Body of the "About you" record with this title in the current Brain, or null when there is none. */
    const aboutBody = (title: string) =>
      win.evaluate(async (wanted) => {
        const hive = (globalThis as unknown as AppWindow).insectoids.hive;
        const hit = (await hive.brainSearch({ query: wanted })).find((h) => h.title === wanted);
        return hit ? ((await hive.brainRecord(hit.id))?.body ?? null) : null;
      }, title);
    // Titles from main/setup-model.ts (aboutTitle).
    const ROLE = 'About you: Role and work';
    const GOALS = 'About you: Current goals';
    const BEFORE = 'Restore check: I look after quokkas.';
    const AFTER = 'Restore check: wombats come after the backup.';

    // A distinctive record (a confirmed fact on the Global shelf), then a backup, then one more record.
    expect((await saveAbout('role', BEFORE)).ok).toBe(true);
    await expect.poll(() => aboutBody(ROLE), { timeout: 10_000 }).toBe(BEFORE);
    const newestBefore = (await backupState(win)).backups[0]?.file;
    await backUpNow(win);
    const backup = (await backupState(win)).backups[0]!.file;
    expect(backup).not.toBe(newestBefore);
    expect((await saveAbout('goals', AFTER)).ok).toBe(true);
    await expect.poll(() => aboutBody(GOALS), { timeout: 10_000 }).toBe(AFTER);

    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    const oldBrainDir = (await setupState()).brainDir;

    const restored = await win.evaluate((f) => (globalThis as unknown as AppWindow).insectoids.backups.restore(f), backup);
    expect(restored.ok, restored.ok ? '' : restored.error).toBe(true);

    // The Brain restarts in a new folder next to the profile's default one.
    await expect.poll(async () => (await setupState()).brainDir, { timeout: 30_000 }).not.toBe(oldBrainDir);
    const brainDir = (await setupState()).brainDir;
    expect(basename(brainDir)).toMatch(/^brain-restored-/);
    expect(dirname(brainDir)).toBe(userData);
    await brainReady(win);
    expect(existsSync(join(brainDir, 'brain.db'))).toBe(true);

    // What was there at the backup is back; what came after isn't.
    await expect.poll(() => aboutBody(ROLE), { timeout: 20_000 }).toBe(BEFORE);
    expect(await aboutBody(GOALS)).toBeNull();
    // The built-in jobs are still there in the restored Brain, with the schedules they had at the backup.
    await expectFiveBuiltIns(win, { defaultSchedules: false });

    // The old Brain was never touched: switching back brings the later record back (a restore can be undone).
    expect(existsSync(join(oldBrainDir, 'brain.db'))).toBe(true);
    const back = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.setup.useDefaultBrainFolder());
    expect(back.ok).toBe(true);
    expect(back.state.brainDir).toBe(back.state.defaultBrainDir);
    await brainReady(win);
    await expect.poll(() => aboutBody(GOALS), { timeout: 20_000 }).toBe(AFTER);
  });
});

test.describe('cadence proposals and the housekeeping list (with a project)', () => {
  test.describe.configure({ mode: 'serial' });
  let t: LaunchedApp;

  test.beforeAll(async () => {
    // harness cadence/repeats.ts), so three quick asks would never be a pattern. This e2e-only env sets the host's
    // retry window to 0, so every ask is its own occasion.
    // e2e-only env and use it as the retry window (0 = every ask is its own occasion). Rename here if it lands differently.
    t = await launchApp({ env: { INSECTOIDS_E2E_PROPOSAL_RETRY_MS: '0' } });
    await brainReady(t.win);
    // No Scout survey before planning: the goals here only need a plan.
    await command(t.win, { type: 'setManagers', scoutBeforePlanning: false });
  });

  test.afterAll(async () => {
    await t?.close();
  });

  const scheduleApprovals = async (win: Page) => (await snapshot(win)).approvals.filter((a) => a.kind === 'schedule');

  /**
   * Gives the Queen a goal as the user would, waits until its plan is in (the fake engine's two-wave plan waits for
   * approval), and cancels it so the next one starts clean. Returns the goal's id.
   */
  async function askAndCancel(win: Page, text: string): Promise<string> {
    const before = new Set((await snapshot(win)).goals.map((g) => g.id));
    expect(await command(win, { type: 'submitGoal', text })).toEqual({ ok: true });
    await expect.poll(async () => (await snapshot(win)).goals.filter((g) => !before.has(g.id)).length, { timeout: 15_000 }).toBe(1);
    const goal = (await snapshot(win)).goals.find((g) => !before.has(g.id))!;
    expect(goal.cadenceId).toBeNull();
    await expect
      .poll(async () => (await snapshot(win)).goals.find((g) => g.id === goal.id)?.status, { timeout: 30_000 })
      .toMatch(/^(awaiting_approval|running|stuck|done)$/);
    expect(await command(win, { type: 'cancelGoal', goalId: goal.id })).toEqual({ ok: true });
    await expect.poll(async () => (await snapshot(win)).goals.find((g) => g.id === goal.id)?.status, { timeout: 15_000 }).toBe('cancelled');
    return goal.id;
  }

  test('the built-in jobs are listed with a project open too', async () => {
    const { win } = t;
    expect((await snapshot(win)).project).not.toBeNull();
    await expect.poll(async () => (await builtIns(win)).length, { timeout: 15_000 }).toBe(MAINTENANCE_JOB_ORDER.length);
    await expectFiveBuiltIns(win);
  });

  test('asking for much the same goal three times proposes a cadence; a yes makes it; a fourth ask proposes nothing new', async () => {
    test.setTimeout(150_000);
    const { win } = t;
    const shelf = (await snapshot(win)).project!.shelf;
    expect(await scheduleApprovals(win)).toHaveLength(0);

    await askAndCancel(win, 'Write the weekly status report for the team');
    await askAndCancel(win, 'Write the weekly status report');
    // Two asks are not a pattern yet.
    expect(await scheduleApprovals(win)).toHaveLength(0);
    await askAndCancel(win, 'Please write the weekly team status report');

    await expect.poll(async () => (await scheduleApprovals(win)).filter((a) => a.status === 'waiting').length, { timeout: 30_000 }).toBe(1);
    const proposal = (await scheduleApprovals(win)).find((a) => a.status === 'waiting')!;
    const userCadencesBefore = (await snapshot(win)).cadences.filter((c) => !c.builtIn).length;

    expect(await command(win, { type: 'approve', approvalId: proposal.id })).toEqual({ ok: true });
    await expect
      .poll(async () => (await snapshot(win)).cadences.filter((c) => !c.builtIn).length, { timeout: 15_000 })
      .toBe(userCadencesBefore + 1);
    const made = (await snapshot(win)).cadences.find((c) => !c.builtIn && /weekly/i.test(c.goal) && /status report/i.test(c.goal));
    expect(made, 'a cadence carrying the repeated goal').toBeDefined();
    expect(made).toMatchObject({ builtIn: false, enabled: true, shelf });
    expect((await scheduleApprovals(win)).find((a) => a.id === proposal.id)?.status).toBe('approved');

    // A fourth ask of the same thing: no second proposal.
    await askAndCancel(win, 'Write the weekly team status report');
    await win.waitForTimeout(3_000);
    expect(await scheduleApprovals(win)).toHaveLength(1);
  });

  test('the Cadence screen lists the housekeeping jobs; Run now on the backup adds a Done run to its history', async () => {
    test.setTimeout(60_000);
    const { win } = t;
    await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Cadence' }).click();
    await expect(win.getByRole('heading', { level: 1, name: 'Cadence' })).toBeVisible();

    const housekeeping = win.getByTestId('housekeeping');
    await expect(housekeeping).toBeVisible();
    const rows = housekeeping.getByTestId('housekeeping-row');
    await expect(rows).toHaveCount(MAINTENANCE_JOB_ORDER.length);
    for (const job of MAINTENANCE_JOB_ORDER) await expect(rows.filter({ hasText: MAINTENANCE_JOBS[job].name })).toHaveCount(1);

    // The backup row, found by the job's name ("Daily backup").
    const row = rows.filter({ hasText: MAINTENANCE_JOBS.backup.name });
    const id = maintenanceCadenceId('backup');
    const before = await doneRuns(win, id);
    // "Run now" in the housekeeping row, as on user cadence rows.
    await row.getByRole('button', { name: 'Run now' }).click();
    await expect.poll(() => doneRuns(win, id), { timeout: 20_000 }).toBe(before + 1);

    // "Runs" opens the same history panel (cadence-history / cadence-run) as user cadences.
    await row.getByRole('button', { name: 'Runs' }).click();
    const history = win.getByTestId('cadence-history');
    await expect(history).toBeVisible();
    const run = history.getByTestId('cadence-run').first();
    await expect(run).toHaveAttribute('data-outcome', 'done', { timeout: 10_000 });
    // The outcome label for `done` reads "Done".
    await expect(run).toContainText('Done');
  });
});
