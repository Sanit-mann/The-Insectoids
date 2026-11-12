/**
 * Phase 1 demo (Step 10): one goal all the way through the hive, with the real app.
 *
 *   INSECTOIDS_DEMO=real  → real Claude Code (spends subscription tokens; capped per run and per goal)
 *   INSECTOIDS_DEMO=fake  → scripted engine, same flow, no tokens (dry run of this runner)
 *   unset                 → skipped (never part of the normal test suite)
 *
 * Flow: Careful preset (every plan waits for you) → goal → approve the Queen's plan → insects work in
 * their own worktrees → Inspector verifies → approve the merge into main → tests pass on main →
 * undo the merge (approved) → main is back → merge again (approved) → tests pass → the Brain has it all.
 *
 * Everything lands in demo-runs/<timestamp>/: the sample project, screenshots, summary.json and activity.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, expect, test } from '@playwright/test';
import type { HiveSnapshot } from '@insectoids/shared';
import { type AppWindow, launchApp } from './support/launch';
import { DEMO_GOAL, makeSampleProject, runSampleTests, sampleGit } from './support/sample-project';

const MODE = process.env['INSECTOIDS_DEMO'];
const REAL = MODE === 'real';
const MIN = 60_000;

test.skip(MODE !== 'real' && MODE !== 'fake', 'Phase 1 demo runs only with INSECTOIDS_DEMO=real or fake.');

const runDir = join(fileURLToPath(new URL('../../..', import.meta.url)), 'demo-runs', new Date().toISOString().replace(/[:.]/g, '-') + (REAL ? '' : '-fake'));
const shot = (win: Page, name: string) => win.screenshot({ path: join(runDir, 'screens', `${name}.png`) });

const snap = (win: Page): Promise<HiveSnapshot> => win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.snapshot());
const cmd = (win: Page, c: Parameters<AppWindow['insectoids']['hive']['command']>[0]) =>
  win.evaluate(async (x) => {
    const r = await (globalThis as unknown as AppWindow).insectoids.hive.command(x);
    if (!r.ok) throw new Error(`${x.type}: ${r.error}`);
  }, c);
const go = (win: Page, name: string) => win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click();

/** Polls the snapshot until `pick` returns something, failing early if the goal gets stuck. */
async function waitFor<T>(win: Page, what: string, timeoutMs: number, pick: (s: HiveSnapshot) => T | undefined | null | false): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await snap(win);
    const hit = pick(s);
    if (hit) return hit;
    const goal = s.goals[0];
    if (goal && (goal.status === 'stuck' || goal.status === 'cancelled')) {
      throw new Error(`Goal ${goal.status} while waiting for ${what}. Last activity:\n${s.activity.slice(-15).map((a) => `- ${a.message}`).join('\n')}`);
    }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await win.waitForTimeout(REAL ? 3000 : 300);
  }
}

const waiting = (s: HiveSnapshot, kind: string) => s.approvals.find((a) => a.status === 'waiting' && a.kind === kind);

test('Phase 1 demo: one goal through the hive', async () => {
  test.setTimeout(REAL ? 60 * MIN : 3 * MIN);
  mkdirSync(join(runDir, 'screens'), { recursive: true });
  const repo = makeSampleProject(join(runDir, 'tiny-text'));
  const base = sampleGit(repo, 'rev-parse', 'HEAD').trim();
  const timings: Record<string, number> = {};
  const t0 = Date.now();
  const mark = (k: string) => (timings[k] = Math.round((Date.now() - t0) / 1000));

  const { win, close } = await launchApp({ repo, env: { INSECTOIDS_ENGINE: REAL ? 'claude' : 'fake' } });
  try {
    await win.setViewportSize({ width: 1440, height: 900 });
    await expect(win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    const engine = await waitFor(win, 'the engine check', 2 * MIN, (s) => s.engine.state !== 'checking' && s.engine);
    if (engine.state !== 'ready' && engine.state !== 'fake') throw new Error(`Engine not ready: ${engine.message}`);

    // Careful preset: even a one-wave plan waits for approval, so the demo always shows plan approval.
    await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.setup.setPreset('careful'));

    // 1. Give the Queen the goal (through the real composer).
    await go(win, 'Queen');
    const composer = win.getByRole('textbox').first();
    await composer.fill(DEMO_GOAL);
    await composer.press('Enter');
    mark('goalSubmitted');

    // 2. The Queen plans; approve the plan.
    const plan = await waitFor(win, "the Queen's plan", 20 * MIN, (s) => waiting(s, 'plan'));
    mark('planReady');
    await win.waitForTimeout(800);
    await shot(win, '01-queen-plan');
    const planned = (await snap(win)).goals[0]!;
    await cmd(win, { type: 'approve', approvalId: plan.id });
    mark('planApproved');

    // 3. Insects work; the Inspector verifies. Take pictures while they work.
    await waitFor(win, 'insects to start', 10 * MIN, (s) => s.hive.working > 0 || waiting(s, 'merge'));
    await go(win, 'Hive');
    await win.waitForTimeout(1500);
    await shot(win, '02-hive-working');
    await go(win, 'Taskboard');
    await win.waitForTimeout(800);
    await shot(win, '03-taskboard-working');

    // Blocked cards (guard "ask" rules) are approved for the demo and logged, so the run can finish.
    const approvedAsks: string[] = [];
    const merge = await waitFor(win, 'the merge approval', 45 * MIN, (s) => {
      const ask = s.approvals.find((a) => a.status === 'waiting' && a.kind === 'risky_action');
      if (ask) {
        approvedAsks.push(`${ask.title} — ${ask.whyItNeedsYou}`);
        void cmd(win, { type: 'approve', approvalId: ask.id });
        return undefined;
      }
      return waiting(s, 'merge');
    });
    mark('allCardsDone');
    await go(win, 'Taskboard');
    await win.waitForTimeout(800);
    await shot(win, '04-taskboard-done');
    await go(win, 'Changes');
    await win.waitForTimeout(800);
    const firstCard = (await snap(win)).cards[0];
    if (firstCard) await win.getByText(firstCard.title, { exact: true }).first().click().catch(() => {});
    await win.waitForTimeout(1200);
    await shot(win, '05-changes');

    // 4. Approve the merge into main; the project's tests must pass on main.
    await go(win, 'Approvals');
    await win.waitForTimeout(600);
    await shot(win, '06-merge-approval');
    await cmd(win, { type: 'approve', approvalId: merge.id });
    await waitFor(win, 'the merge', 2 * MIN, (s) => s.goals[0]?.merge === 'merged');
    mark('merged');
    const filesMerged = sampleGit(repo, 'diff', '--name-status', base, 'main').trim();
    expect(filesMerged, 'the merge changed main').not.toBe('');
    const testsAfterMerge = runSampleTests(repo);
    if (REAL) expect(testsAfterMerge.ok, `node --test on main after the merge:\n${testsAfterMerge.output}`).toBe(true);

    // 5. Undo the merge (needs approval): main's files go back to how they were.
    await cmd(win, { type: 'requestUndoMerge', goalId: planned.id });
    const undo = await waitFor(win, 'the undo approval', MIN, (s) => waiting(s, 'merge'));
    await cmd(win, { type: 'approve', approvalId: undo.id });
    await waitFor(win, 'the undo', 2 * MIN, (s) => s.goals[0]?.merge === 'undone');
    mark('undone');
    expect(sampleGit(repo, 'diff', '--name-status', base, 'main').trim(), 'main matches the start after undo').toBe('');

    // 6. Merge again (redo, needs approval): the work is back and the tests pass.
    await cmd(win, { type: 'requestRedoMerge', goalId: planned.id });
    const redo = await waitFor(win, 'the redo approval', MIN, (s) => waiting(s, 'merge'));
    await cmd(win, { type: 'approve', approvalId: redo.id });
    await waitFor(win, 'the redo', 2 * MIN, (s) => s.goals[0]?.merge === 'merged');
    mark('redone');
    expect(sampleGit(repo, 'diff', '--name-status', base, 'main').trim()).toBe(filesMerged);
    const testsAfterRedo = runSampleTests(repo);
    if (REAL) expect(testsAfterRedo.ok, `node --test on main after the redo:\n${testsAfterRedo.output}`).toBe(true);

    // 7. The Brain shows the decisions, tasks and outcomes.
    const brain = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.brainSearch({ query: '' }));
    await go(win, 'Brain');
    await win.waitForTimeout(1000);
    await shot(win, '07-brain');
    await go(win, 'Queen');
    await win.waitForTimeout(800);
    await shot(win, '08-queen-done');
    await go(win, 'Hive');
    await win.waitForTimeout(800);
    await shot(win, '09-hive-done');

    // Summary for the report.
    const end = await snap(win);
    const goal = end.goals[0]!;
    writeFileSync(
      join(runDir, 'summary.json'),
      `${JSON.stringify(
        {
          mode: MODE,
          goal: { title: goal.title, status: goal.status, merge: goal.merge, spentTokens: goal.spentTokens, spentUsd: goal.spentUsd, budgetTokens: goal.budgetTokens },
          plan: planned.plan,
          cards: end.cards.map((c) => ({ id: c.id, title: c.title, caste: c.caste, wave: c.wave, status: c.status, attempts: c.attempts, undone: c.undone })),
          runs: end.agents.map((a) => ({ agent: a.agentId, role: a.role, task: a.title, model: a.model, effort: a.effort, status: a.status, tokens: a.tokens, costUsd: a.costUsd, seconds: a.endedAt ? Math.round((a.endedAt - a.startedAt) / 1000) : null })),
          approvedAsks,
          filesMerged: filesMerged.split('\n'),
          testsOnMain: { afterMerge: testsAfterMerge.ok, afterRedo: testsAfterRedo.ok },
          brainRecords: brain.map((b) => `[${b.kind}] ${b.title}`),
          timingsSeconds: timings,
          sampleProject: repo,
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(runDir, 'activity.md'), `# Activity\n\n${end.activity.map((a) => `- ${new Date(a.at).toISOString().slice(11, 19)} ${a.message}`).join('\n')}\n`);
    for (const a of end.agents) writeFileSync(join(runDir, `output-${a.runId.replace(/[^\w.-]/g, '_')}.log`), `${a.agentId} · ${a.title}\n\n${a.output.join('\n')}\n`);
  } catch (err) {
    await shot(win, 'zz-failure').catch(() => {});
    const s = await snap(win).catch(() => null);
    if (s) writeFileSync(join(runDir, 'failure-snapshot.json'), JSON.stringify(s, null, 2));
    throw err;
  } finally {
    await close();
  }
});
