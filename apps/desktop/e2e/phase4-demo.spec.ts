/**
 * Phase 4 demo (step E1): the hive reaches further and stays safe while it does. The real app on the tiny-text
 * sample project, with the e2e Brain seed (a few linked records, among them the "Hosting provider" facts).
 *
 *   INSECTOIDS_DEMO4=real → real engines do the work (Claude Code and GitHub Copilot, both subscriptions): usage is
 *                           spent, so the user says yes first, after a cost estimate
 *   INSECTOIDS_DEMO4=fake → the scripted engine, same flow, no tokens (a dry run of this runner)
 *   unset                 → skipped (never part of the normal test suite)
 *   INSECTOIDS_DEMO4_RUNTIME=real → Docker or Podman on this computer runs the containers (the image must already be
 *                           downloaded, or INSECTOIDS_DEMO4_PULL=1 downloads the pinned default image first)
 *   INSECTOIDS_DEMO4_RUNTIME unset or fake → the fake runtime (packages/workspace/src/fake-runtime.mjs): the hive does
 *                           everything it would with a real one, but the commands run on this computer
 *
 * What it shows (docs/plans/phase-4-expansion.md, goal at the top):
 * 1. Ask the Brain a plain-words question: the answer cites records, each one real and current; the Globe shows the
 *    same records, and clicking one there opens it.
 * 2. (Calendar and mail: set aside with C1–C3 on 2026-11-15, so not part of this run.)
 * 3. Containers "When needed": a goal that runs a contributor's unfamiliar build script. The Queen marks its card as
 *    risky, so that card's runs go into a container, while the hive's other runs don't.
 * 4. GitHub Copilot first in the engine order: a small coding goal runs on Copilot, a second subscription engine.
 * Each goal's merge is approved, its change is on main, and the sample project's tests still pass.
 *
 * Everything lands in demo-runs/<timestamp>-phase4[-fake]/: the sample project, screenshots, summary.json,
 * activity.md and each run's output.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, expect, test } from '@playwright/test';
import { type ContainerStatus, DEFAULT_CONTAINER_IMAGE, type HiveSnapshot } from '@insectoids/shared';
import { type AppWindow, launchApp } from './support/launch';
import { makeSampleProject, runSampleTests, sampleGit } from './support/sample-project';

const MODE = process.env['INSECTOIDS_DEMO4'];
const REAL = MODE === 'real';
const REAL_RUNTIME = process.env['INSECTOIDS_DEMO4_RUNTIME'] === 'real';
const PULL = process.env['INSECTOIDS_DEMO4_PULL'] === '1';
const MIN = 60_000;

test.skip(MODE !== 'real' && MODE !== 'fake', 'Phase 4 demo runs only with INSECTOIDS_DEMO4=real or fake.');

const FAKE_RUNTIME = fileURLToPath(new URL('../../../packages/workspace/src/fake-runtime.mjs', import.meta.url));

/** About the seeded "Hosting provider" facts (an old one, Netlify, replaced by a current one, Vercel). */
const QUESTION = 'Which hosting provider does the project use?';

/** A contributor's build script: plain Node, no network, writes one generated file. */
const CONTRIBUTOR_SCRIPT = `// Sent by a contributor: builds src/word-index.json (how often each README word appears).
import { readFileSync, writeFileSync } from 'node:fs';

const words = readFileSync('README.md', 'utf8').toLowerCase().match(/[a-z]+/g) ?? [];
const counts = {};
for (const w of words) counts[w] = (counts[w] ?? 0) + 1;
writeFileSync('src/word-index.json', \`\${JSON.stringify(counts, null, 2)}\\n\`);
console.log(\`Indexed \${Object.keys(counts).length} words.\`);
`;

/**
 * The goals. The scripted engine picks its plan by words in the goal ("farewell function" = one card; a word starting
 * with "install" = the Queen marks that card as risky), so the dry run uses its own wording.
 */
const SCRIPT_GOAL = REAL
  ? [
      'A contributor sent scripts/make-index.mjs, a build script we have not reviewed.',
      'Run it once with `node scripts/make-index.mjs` from the project folder so it writes src/word-index.json, then commit that generated file.',
      'Do not edit the script, do not install any packages, and change no other file.',
      'Plan it as one wave with a single coder card.',
    ].join(' ')
  : 'Add a farewell function and install its packages';
const COPILOT_GOAL = REAL
  ? [
      'Add a titleCase(text) function to tiny-text: it capitalises the first letter of every word and lowercases the rest.',
      'Export it from src/index.js and add tests with node:test in test/title-case.test.js.',
      'Keep the library dependency-free; `node --test` must pass. Plan it as one wave with a single coder card.',
    ].join(' ')
  : 'Add a farewell function to tiny-text';

const runDir = join(fileURLToPath(new URL('../../..', import.meta.url)), 'demo-runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-phase4${REAL ? '' : '-fake'}`);
const shot = (win: Page, name: string) => win.screenshot({ path: join(runDir, 'screens', `${name}.png`) });
const snap = (win: Page): Promise<HiveSnapshot> => win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.snapshot());
const cmd = (win: Page, c: Parameters<AppWindow['insectoids']['hive']['command']>[0]) =>
  win.evaluate(async (x) => {
    const r = await (globalThis as unknown as AppWindow).insectoids.hive.command(x);
    if (!r.ok) throw new Error(`${x.type}: ${r.error}`);
  }, c);
const containerStatus = (win: Page): Promise<ContainerStatus> => win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.containers.status());
const nav = (win: Page, screen: string) => win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: screen, exact: true }).click();
const lastActivity = (s: HiveSnapshot): string => s.activity.slice(-15).map((a) => `- ${a.message}`).join('\n');

/** Polls the snapshot until `pick` returns something; fails early if the goal gets stuck or the hive pauses. */
async function waitFor<T>(win: Page, what: string, timeoutMs: number, goalId: string | null, pick: (s: HiveSnapshot) => T | undefined | null | false): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await snap(win);
    const hit = pick(s);
    if (hit) return hit;
    const goal = goalId ? s.goals.find((g) => g.id === goalId) : undefined;
    if (goal && (goal.status === 'stuck' || goal.status === 'cancelled')) throw new Error(`Goal ${goal.status} while waiting for ${what}. Last activity:\n${lastActivity(s)}`);
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}. Last activity:\n${lastActivity(s)}`);
    await win.waitForTimeout(REAL ? 3000 : 500);
  }
}

/**
 * Submits a goal and drives it to its merge: a plan that waits for approval is approved (the demo's goals ask for one
 * card, but a real Queen may plan more); any other approval stops the demo, since the user should look at it.
 */
async function runGoal(win: Page, text: string, budgetTokens: number): Promise<{ goalId: string; mergeId: string }> {
  await cmd(win, { type: 'submitGoal', text, budgetTokens });
  const goalId = await waitFor(win, 'the goal', MIN, null, (s) => s.goals.find((g) => g.text === text)?.id);
  const mergeId = await waitFor(win, 'the merge approval', REAL ? 25 * MIN : 3 * MIN, goalId, (s) => {
    for (const a of s.approvals.filter((x) => x.goalId === goalId && x.status === 'waiting')) {
      if (a.kind === 'merge') return a.id;
      if (a.kind !== 'plan') throw new Error(`The goal asks for an approval the demo leaves to the user: ${a.kind} "${a.title}".`);
    }
    return undefined;
  });
  // Plans that waited were approved by `approvePlans` below, polled alongside.
  return { goalId, mergeId };
}

/** Approves waiting plan approvals for this goal while it runs (polled in the background of `runGoal`). */
function approvePlans(win: Page, text: string): { stop(): void } {
  let on = true;
  void (async () => {
    while (on) {
      const s = await snap(win).catch(() => null);
      const goal = s?.goals.find((g) => g.text === text);
      const plan = goal && s?.approvals.find((a) => a.goalId === goal.id && a.status === 'waiting' && a.kind === 'plan');
      if (plan) await cmd(win, { type: 'approve', approvalId: plan.id }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
  return { stop: () => (on = false) };
}

async function mergeAndCheck(win: Page, goalId: string, mergeId: string, name: string): Promise<void> {
  await cmd(win, { type: 'approve', approvalId: mergeId });
  await waitFor(win, `the merge of ${name}`, 3 * MIN, goalId, (s) => s.goals.find((g) => g.id === goalId && g.status === 'done'));
}

test('Phase 4 demo: Ask the Brain and the Globe, a risky card in a container, a card on GitHub Copilot', async () => {
  test.setTimeout(REAL ? 60 * MIN : 8 * MIN);
  mkdirSync(join(runDir, 'screens'), { recursive: true });
  const repo = makeSampleProject(join(runDir, 'tiny-text'));
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'scripts', 'make-index.mjs'), CONTRIBUTOR_SCRIPT);
  sampleGit(repo, 'add', '-A');
  sampleGit(repo, 'commit', '-q', '-m', 'Add a contributor build script');

  const box = join(runDir, 'fake-runtime');
  mkdirSync(box, { recursive: true });
  const runtimeLog = join(box, 'runtime.log');
  const runtimeEnv: Record<string, string> = REAL_RUNTIME
    ? {}
    : {
        INSECTOIDS_E2E_CONTAINER_RUNTIME: FAKE_RUNTIME,
        INSECTOIDS_E2E_CONTAINER_NODE: process.execPath,
        FAKE_RUNTIME_STATE: join(box, 'state.json'),
        FAKE_RUNTIME_LOG: runtimeLog,
        FAKE_RUNTIME_IMAGES: DEFAULT_CONTAINER_IMAGE,
      };

  const { win, close } = await launchApp({
    repo,
    env: { INSECTOIDS_ENGINE: REAL ? 'claude' : 'fake', INSECTOIDS_E2E_BRAIN_SEED: '1', ...runtimeEnv },
  });
  const started = Date.now();
  const summary: Record<string, unknown> = { mode: MODE, runtime: REAL_RUNTIME ? 'real' : 'fake', startedAt: new Date(started).toISOString() };
  summary['calendarAndMail'] = 'Not part of this run: OAuth, Google Calendar and Gmail (C1–C3) were set aside on 2026-11-15.';
  try {
    await expect(win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: MIN });
    await expect(win.getByLabel('Message the Queen')).toBeEnabled({ timeout: MIN });
    // The Scout's survey isn't what this demo shows; leaving it out keeps the cost down.
    await cmd(win, { type: 'setManagers', scoutBeforePlanning: false });
    if (REAL) {
      await cmd(win, { type: 'setEngineEnabled', engineId: 'copilot', enabled: true });
      await cmd(win, { type: 'checkEngine' });
      const engines = await waitFor(win, 'the engine checks', 3 * MIN, null, (s) => !s.engines.some((e) => e.state === 'checking') && s.engines);
      summary['engines'] = engines.map((e) => ({ id: e.id, state: e.state, version: e.version ?? null }));
      for (const id of ['claude', 'copilot'] as const) {
        const e = engines.find((x) => x.id === id);
        if (e?.state !== 'ready') throw new Error(`${id} is not ready (${e?.state ?? 'not listed'}): ${e?.message ?? ''}`);
      }
      // Claude Code first for parts 1 and 3; Copilot moves to the front for part 4.
      await cmd(win, { type: 'setEngineOrder', order: ['claude', 'copilot'] });
    }
    // The seed is written when the project opens; wait until it is searchable.
    await expect
      .poll(async () => (await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.brainSearch({ query: 'hosting provider' }))).length, { timeout: 30_000 })
      .toBeGreaterThan(0);

    // ---- 1. Ask the Brain, then the same records on the Globe ----------------------------------------
    await nav(win, 'Brain');
    await win.getByRole('tablist', { name: 'Brain view' }).getByRole('tab', { name: 'Notes', exact: true }).click();
    const panel = win.getByTestId('brain-ask');
    await expect(panel.getByTestId('brain-ask-estimate')).toBeVisible({ timeout: 15_000 });
    const estimate = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.brainAskEstimate());
    summary['askEstimate'] = estimate;
    expect(estimate.canAsk, estimate.message).toBe(true);
    await panel.getByLabel('Ask the Brain a question').fill(QUESTION);
    await panel.getByRole('button', { name: 'Ask', exact: true }).click();
    const result = panel.getByTestId('brain-ask-result');
    await expect(result).toHaveAttribute('data-status', 'answered', { timeout: REAL ? 5 * MIN : 30_000 });
    const sources = result.getByRole('button', { name: /^Source \d+: / });
    const labels = await sources.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? ''));
    const cited = [...new Set(labels.map((l) => /^Source \d+:\s*(.+)$/.exec(l.trim())?.[1]?.trim() ?? '').filter(Boolean))];
    expect(cited.length).toBeGreaterThan(0);
    // Every cited record is real and current (search shows current records only).
    const citedIds: Record<string, string> = {};
    for (const title of cited) {
      const hits = await win.evaluate((q) => (globalThis as unknown as AppWindow).insectoids.hive.brainSearch({ query: q }), title);
      const hit = hits.find((h) => h.title === title);
      expect(hit, `cited record "${title}" is a current record`).toBeTruthy();
      citedIds[title] = hit!.id;
    }
    summary['ask'] = { question: QUESTION, result: (await result.innerText()).trim(), cited };
    await shot(win, '01-ask-the-brain');

    await win.getByRole('tablist', { name: 'Brain view' }).getByRole('tab', { name: 'Globe', exact: true }).click();
    const globe = win.getByTestId('brain-globe');
    await expect(globe).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await win.getByRole('group', { name: 'Which shelf' }).getByRole('button', { name: 'All', exact: true }).click();
    const list = win.getByTestId('globe-list');
    for (const title of cited) await expect(list.getByRole('button', { name: title }).first()).toBeVisible({ timeout: 15_000 });
    const first = cited[0]!;
    await list.getByRole('button', { name: first }).first().click();
    await expect(globe).toHaveAttribute('data-selected', citedIds[first]!, { timeout: 10_000 });
    await expect(win.getByTestId('brain-reader').getByRole('heading', { name: first, exact: true })).toBeVisible({ timeout: 10_000 });
    summary['globe'] = { nodes: Number(await globe.getAttribute('data-nodes')), edges: Number(await globe.getAttribute('data-edges')), selected: first };
    await shot(win, '02-globe');

    // ---- 3. Containers "When needed": the contributor's script runs in a container ---------------------
    let box0 = await containerStatus(win);
    const saved = await win.evaluate((s) => (globalThis as unknown as AppWindow).insectoids.containers.save(s), { ...box0.settings, mode: 'auto' as const });
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    box0 = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.containers.recheck());
    if (REAL_RUNTIME && box0.runtime.state === 'ready' && box0.imagePresent === false && PULL) {
      const pulled = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.containers.pullImage());
      expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
      await expect.poll(async () => (await containerStatus(win)).usable, { timeout: 20 * MIN, intervals: [5000] }).toBe(true);
      box0 = await containerStatus(win);
    }
    summary['containers'] = { runtime: box0.runtime, image: box0.settings.image, imagePresent: box0.imagePresent, message: box0.message };
    if (!box0.usable) throw new Error(`Containers aren't ready: ${box0.message}`);

    const plans3 = approvePlans(win, SCRIPT_GOAL);
    const script = await runGoal(win, SCRIPT_GOAL, 300_000).finally(() => plans3.stop());
    const s3 = await snap(win);
    const scriptCards = s3.cards.filter((c) => c.goalId === script.goalId);
    const boxed = scriptCards.filter((c) => c.container?.state === 'container');
    expect(boxed.length, `a card of the script goal runs in a container (cards: ${JSON.stringify(scriptCards.map((c) => ({ title: c.title, container: c.container })))})`).toBeGreaterThan(0);
    expect(boxed.every((c) => c.container!.source === 'queen')).toBe(true);
    const scriptRuns = s3.agents.filter((a) => a.goalId === script.goalId);
    expect(scriptRuns.some((a) => a.container)).toBe(true);
    // Only the marked card's runs (its insect and its Inspector) had a container: the Queen's plan ran as before.
    expect(scriptRuns.filter((a) => a.role === 'queen').every((a) => !a.container)).toBe(true);
    if (!REAL_RUNTIME) expect(readFileSync(runtimeLog, 'utf8')).toMatch(/"label=io\.insectoids\.run=insectoids-[a-z0-9-]+"/);
    summary['scriptGoal'] = {
      cards: scriptCards.map((c) => ({ title: c.title, container: c.container })),
      runs: scriptRuns.map((a) => ({ role: a.role, caste: a.caste, engine: a.engine, model: a.model, container: a.container, tokens: a.tokens, costUsd: a.costUsd })),
    };
    await nav(win, 'Taskboard');
    await win.getByRole('combobox', { name: /^Goal/ }).selectOption(script.goalId);
    await shot(win, '03-card-in-a-container');
    await nav(win, 'Hive');
    await shot(win, '04-hive-lanes');
    await mergeAndCheck(win, script.goalId, script.mergeId, 'the script goal');
    if (REAL) {
      expect(sampleGit(repo, 'ls-tree', '-r', '--name-only', 'main')).toContain('src/word-index.json');
      expect(sampleGit(repo, 'show', 'main:scripts/make-index.mjs')).toBe(CONTRIBUTOR_SCRIPT);
    }

    // ---- 4. A card on GitHub Copilot -----------------------------------------------------------------
    if (REAL) await cmd(win, { type: 'setEngineOrder', order: ['copilot', 'claude'] });
    const plans4 = approvePlans(win, COPILOT_GOAL);
    const cop = await runGoal(win, COPILOT_GOAL, 300_000).finally(() => plans4.stop());
    const s4 = await snap(win);
    const coders = s4.agents.filter((a) => a.goalId === cop.goalId && a.role === 'insect');
    expect(coders.length).toBeGreaterThan(0);
    expect(coders.every((a) => a.engine === (REAL ? 'copilot' : 'fake')), JSON.stringify(coders.map((a) => a.engine))).toBe(true);
    summary['copilotGoal'] = {
      runs: s4.agents.filter((a) => a.goalId === cop.goalId).map((a) => ({ role: a.role, caste: a.caste, engine: a.engine, model: a.model, why: a.routeReason ?? null, tokens: a.tokens, costUsd: a.costUsd })),
    };
    await nav(win, 'Hive');
    await shot(win, '05-copilot-lane');
    await mergeAndCheck(win, cop.goalId, cop.mergeId, 'the Copilot goal');
    if (REAL) {
      await cmd(win, { type: 'setEngineOrder', order: ['claude', 'copilot'] });
      expect(sampleGit(repo, 'show', 'main:src/index.js')).toMatch(/export function titleCase/);
    }
    await nav(win, 'Queen');
    await shot(win, '06-both-merged');

    const tests = runSampleTests(repo);
    expect(tests.ok, tests.output).toBe(true);

    const end = await snap(win);
    summary['goals'] = end.goals.map((g) => ({ title: g.title, status: g.status, spentTokens: g.spentTokens, spentUsd: g.spentUsd }));
    summary['runs'] = end.agents.map((a) => ({ agent: a.agentId, role: a.role, engine: a.engine, model: a.model, task: a.title, status: a.status, container: a.container, tokens: a.tokens, costUsd: a.costUsd }));
    summary['passed'] = true;
    writeFileSync(join(runDir, 'activity.md'), `# Activity\n\n${end.activity.map((a) => `- ${new Date(a.at).toISOString().slice(11, 19)} ${a.message}`).join('\n')}\n`);
    for (const a of end.agents) writeFileSync(join(runDir, `output-${a.runId.replace(/[^\w.-]/g, '_')}.log`), `${a.agentId} · ${a.engine ?? '?'} · ${a.model ?? '?'} · ${a.title}\n\n${a.output.join('\n')}\n`);
  } catch (err) {
    summary['passed'] = false;
    summary['error'] = err instanceof Error ? err.message : String(err);
    await shot(win, '99-failure').catch(() => undefined);
    const s = await snap(win).catch(() => null);
    if (s) writeFileSync(join(runDir, 'activity.md'), `# Activity (failed)\n\n${s.activity.map((a) => `- ${new Date(a.at).toISOString().slice(11, 19)} ${a.message}`).join('\n')}\n`);
    throw err;
  } finally {
    summary['durationSeconds'] = Math.round((Date.now() - started) / 1000);
    writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    await close();
  }
  expect(readdirSync(join(runDir, 'screens')).length).toBeGreaterThanOrEqual(6);
  expect(readFileSync(join(runDir, 'summary.json'), 'utf8')).toContain('"passed": true');
  if (!REAL_RUNTIME) expect(existsSync(runtimeLog)).toBe(true);
});
