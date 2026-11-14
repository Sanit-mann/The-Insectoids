/**
 * Phase 3 demo (step C5): the hive works without being asked. The real app on the tiny-text sample project.
 *
 *   INSECTOIDS_DEMO3=real → Claude Code (subscription) does the work: tokens are spent, so the user says yes first,
 *                           after a cost estimate
 *   INSECTOIDS_DEMO3=fake → the scripted engine, same flow, no tokens (a dry run of this runner)
 *   unset                 → skipped (never part of the normal test suite)
 *   INSECTOIDS_PACKAGED_EXE=<path> → run the installed app instead of the dev build (Phase 3 goal 3: it installs
 *                           from the installer); it still uses a throwaway data folder, never the real Brain.
 *
 * What it shows (docs/plans/phase-3-cadence-polish.md, goal at the top):
 * 1. a weekly cadence (this weekday, a couple of minutes from now, local time) runs on its own while the app sits in
 *    the tray with the window closed, as normal hive work through the Queen;
 * 2. "the next morning": the window comes back from the tray and the "while you were away" digest opens by itself,
 *    showing what ran, what it cost, and that the merge waits for the user; a desktop notification was decided for
 *    that approval while the window was away;
 * 3. the user approves the merge: the report lands on main, and the sample project's tests still pass.
 *
 * Everything lands in demo-runs/<timestamp>-phase3[-fake]/: the sample project, screenshots, summary.json,
 * activity.md and each run's output.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, expect, test } from '@playwright/test';
import type { BackgroundE2E, DigestView, HiveSnapshot } from '@insectoids/shared';
import { type AppWindow, launchApp } from './support/launch';
import { makeSampleProject, runSampleTests, sampleGit } from './support/sample-project';

const MODE = process.env['INSECTOIDS_DEMO3'];
const REAL = MODE === 'real';
const EXE = process.env['INSECTOIDS_PACKAGED_EXE'];
const MIN = 60_000;

test.skip(MODE !== 'real' && MODE !== 'fake', 'Phase 3 demo runs only with INSECTOIDS_DEMO3=real or fake.');

/** The weekly report: one small card, no code changes, so the plan is one wave and the cost stays small. */
export const REPORT_GOAL = [
  "Write this week's status report for tiny-text.",
  'Read the git log of the last 7 days and the current README, then write reports/weekly.md with three short sections:',
  '"Done this week" (one line per commit, newest first), "What the library can do now" (its exported functions, one line each)',
  'and "Next" (two or three small suggestions). Plain Markdown, at most 40 lines. Change no other file.',
  'Plan it as one wave with a single documenter card.',
].join(' ');

const runDir = join(fileURLToPath(new URL('../../..', import.meta.url)), 'demo-runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-phase3${REAL ? '' : '-fake'}`);
const shot = (win: Page, name: string) => win.screenshot({ path: join(runDir, 'screens', `${name}.png`) });
const snap = (win: Page): Promise<HiveSnapshot> => win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.snapshot());
const cmd = (win: Page, c: Parameters<AppWindow['insectoids']['hive']['command']>[0]) =>
  win.evaluate(async (x) => {
    const r = await (globalThis as unknown as AppWindow).insectoids.hive.command(x);
    if (!r.ok) throw new Error(`${x.type}: ${r.error}`);
  }, c);
const lastActivity = (s: HiveSnapshot): string => s.activity.slice(-15).map((a) => `- ${a.message}`).join('\n');

/** Polls the snapshot until `pick` returns something, failing early if the goal gets stuck. */
async function waitFor<T>(win: Page, what: string, timeoutMs: number, pick: (s: HiveSnapshot) => T | undefined | null | false): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await snap(win);
    const hit = pick(s);
    if (hit) return hit;
    const goal = s.goals[0];
    if (goal && (goal.status === 'stuck' || goal.status === 'cancelled')) throw new Error(`Goal ${goal.status} while waiting for ${what}. Last activity:\n${lastActivity(s)}`);
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}. Last activity:\n${lastActivity(s)}`);
    await win.waitForTimeout(REAL ? 3000 : 500);
  }
}

/** The next whole minute at least 75 s from now, as local "HH:MM" and its weekday, so the weekly cadence is due soon. */
function dueSoon(now = new Date()): { time: string; day: number; at: number } {
  const d = new Date(now.getTime() + 75_000);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  return { time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, day: d.getDay(), at: d.getTime() };
}

test('Phase 3 demo: a weekly report runs from the tray, and the morning digest shows it', async () => {
  test.setTimeout(REAL ? 30 * MIN : 6 * MIN);
  mkdirSync(join(runDir, 'screens'), { recursive: true });
  const repo = makeSampleProject(join(runDir, 'tiny-text'));
  // A week of history for the report to read.
  writeFileSync(join(repo, 'CHANGELOG.md'), '# Changelog\n\n- wordCount counts words.\n');
  sampleGit(repo, 'add', '-A');
  sampleGit(repo, 'commit', '-q', '-m', 'Add a changelog');

  const { app, win, close } = await launchApp({
    repo,
    ...(EXE ? { executablePath: EXE } : {}),
    env: { INSECTOIDS_ENGINE: REAL ? 'claude' : 'fake', INSECTOIDS_E2E_TRAY_CLOSE: '1' },
  });
  const started = Date.now();
  const summary: Record<string, unknown> = { mode: MODE, packaged: Boolean(EXE), startedAt: new Date(started).toISOString() };
  try {
    await expect.poll(async () => (await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.brainStatus())).state, { timeout: MIN }).toBe('ready');
    if (REAL) {
      const engines = await waitFor(win, 'the engine checks', 3 * MIN, (s) => !s.engines.some((e) => e.state === 'checking') && s.engines);
      const claude = engines.find((e) => e.id === 'claude');
      if (claude?.state !== 'ready') throw new Error(`Claude Code is not ready (${claude?.state ?? 'not listed'}): ${claude?.message ?? ''}`);
    }

    // 1. A weekly cadence, due a couple of minutes from now, that may run on its own.
    const due = dueSoon();
    await cmd(win, {
      type: 'createCadence',
      cadence: { name: 'Weekly report', when: { type: 'weekly', days: [due.day], time: due.time }, goal: REPORT_GOAL, budgetTokens: 150_000, autonomy: 'run', enabled: true },
    });
    const cadence = (await snap(win)).cadences.find((c) => c.name === 'Weekly report' && !c.builtIn)!;
    expect(cadence.nextRunAt).toBe(due.at);
    summary['cadence'] = { whenText: cadence.whenText, dueAt: new Date(due.at).toISOString() };
    await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Cadence', exact: true }).click();
    await shot(win, '01-cadence-scheduled');

    // Close the window: the app keeps working in the tray.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false);
    // The tray follows the hive about half a second after each change: it names the weekly report as the next run.
    const trayLabels = () => app.evaluate(() => (globalThis as unknown as { __insectoidsE2E: BackgroundE2E }).__insectoidsE2E.tray?.items.map((i) => i.label) ?? []);
    await expect.poll(trayLabels, { timeout: 10_000 }).toContainEqual(expect.stringMatching(/^Next: Weekly report /));
    summary['trayWhileAway'] = await trayLabels();

    // 2. It runs on its own at the scheduled time, and gets as far as it can without the user: the merge waits.
    const goal = await waitFor(win, 'the weekly run to start', due.at - Date.now() + 2 * MIN, (s) => s.goals.find((g) => g.cadenceId === cadence.id));
    const run = (await win.evaluate((id) => (globalThis as unknown as AppWindow).insectoids.hive.cadenceRuns({ cadenceId: id }), cadence.id))[0];
    expect(run).toMatchObject({ reason: 'schedule', outcome: 'started' });
    const merge = await waitFor(win, 'the report to be ready to merge', REAL ? 20 * MIN : 3 * MIN, (s) =>
      s.approvals.find((a) => a.status === 'waiting' && a.kind === 'merge' && a.goalId === goal.id),
    );
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false);
    // Notifications are grouped for a few seconds before one is shown: the merge waiting is one of them.
    const notices = () => app.evaluate(() => (globalThis as unknown as { __insectoidsE2E: BackgroundE2E }).__insectoidsE2E.notices);
    await expect.poll(async () => (await notices()).some((n) => n.kind === 'approval'), { timeout: 15_000 }).toBe(true);
    summary['notices'] = await notices();

    // 3. "The next morning": the window comes back from the tray and the digest opens by itself.
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      w.show();
      w.focus();
    });
    const dialog = win.getByRole('dialog', { name: 'While you were away' });
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    const digest: DigestView = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.digest());
    const mine = digest.cadences.find((c) => c.cadenceId === cadence.id);
    expect(mine?.goals.some((g) => g.goalId === goal.id && g.waitingFor === 'merge')).toBe(true);
    expect(digest.totals.runs).toBeGreaterThanOrEqual(1);
    expect(digest.waiting.byKind['merge'] ?? 0).toBeGreaterThanOrEqual(1);
    if (REAL) expect(digest.totals.tokens).toBeGreaterThan(0);
    summary['digest'] = { headline: digest.headline, totals: digest.totals, waiting: digest.waiting.byKind, goal: mine?.goals.find((g) => g.goalId === goal.id) };
    await shot(win, '02-morning-digest');
    await dialog.getByRole('button', { name: 'Got it', exact: true }).click();

    // 4. The user approves the merge: the report is on main and the tests still pass.
    await cmd(win, { type: 'approve', approvalId: merge.id });
    await waitFor(win, 'the merge', 3 * MIN, (s) => s.goals.find((g) => g.id === goal.id && g.status === 'done'));
    await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Queen', exact: true }).click();
    await shot(win, '03-merged');
    // The scripted engine writes its own placeholder files, so only the real run is held to the report itself.
    let report = '';
    if (REAL) {
      const files = sampleGit(repo, 'ls-tree', '-r', '--name-only', 'main');
      expect(files).toContain('reports/weekly.md');
      report = sampleGit(repo, 'show', 'main:reports/weekly.md');
      writeFileSync(join(runDir, 'weekly-report.md'), report);
    }
    const tests = runSampleTests(repo);
    expect(tests.ok, tests.output).toBe(true);

    const end = await snap(win);
    const g = end.goals.find((x) => x.id === goal.id)!;
    summary['goal'] = { title: g.title, status: g.status, spentTokens: g.spentTokens, spentUsd: g.spentUsd };
    summary['runs'] = end.agents.map((a) => ({ agent: a.agentId, engine: a.engine, model: a.model, task: a.title, status: a.status, tokens: a.tokens, costUsd: a.costUsd }));
    summary['reportLines'] = report ? report.split('\n').length : null;
    summary['passed'] = true;
    writeFileSync(join(runDir, 'activity.md'), `# Activity\n\n${end.activity.map((a) => `- ${new Date(a.at).toISOString().slice(11, 19)} ${a.message}`).join('\n')}\n`);
    for (const a of end.agents) writeFileSync(join(runDir, `output-${a.runId.replace(/[^\w.-]/g, '_')}.log`), `${a.agentId} · ${a.engine ?? '?'} · ${a.model ?? '?'} · ${a.title}\n\n${a.output.join('\n')}\n`);
  } catch (err) {
    summary['passed'] = false;
    summary['error'] = err instanceof Error ? err.message : String(err);
    await shot(win, '99-failure').catch(() => undefined);
    throw err;
  } finally {
    summary['durationSeconds'] = Math.round((Date.now() - started) / 1000);
    writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    await close();
  }
  expect(readdirSync(join(runDir, 'screens')).length).toBeGreaterThanOrEqual(3);
  expect(readFileSync(join(runDir, 'summary.json'), 'utf8')).toContain('"passed": true');
});
