/**
 * Phase 2 demo (step C6): the whole hive, across two engines, learning as it goes. The real app on the
 * tiny-text sample project.
 *
 *   INSECTOIDS_DEMO2=real → the real engine registry: Claude Code (subscription) for the Queen, the Inspector and
 *                           normal work; OpenCode + Ollama (a free local model, qwen3-8b-16k) for light work
 *   INSECTOIDS_DEMO2=fake → the scripted engine, same flow, no tokens (a dry run of this runner)
 *   unset                 → skipped (never part of the normal test suite)
 *
 * What it shows (docs/plans/phase-2-full-hive.md, goal at the top; the second engine is the local model,
 * the user's choice on 2026-11-14):
 * 1. a multi-wave goal across 3+ castes and 2 engines;
 * 2. each run routed by cost and by what has worked before (engine, model and the Treasurer's reason recorded);
 * 3. the Brain finding a record by meaning, not just keywords;
 * 4. the hive proposing a new skill from repeated work (approved, then Ready in the Library);
 * 5. the merge into main after approval, with the sample project's tests passing on main.
 *
 * Everything lands in demo-runs/<timestamp>-phase2[-fake]/: the sample project, screenshots, summary.json,
 * activity.md and each run's output.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, expect, test } from '@playwright/test';
import type { HiveSnapshot } from '@insectoids/shared';
import { type AppWindow, launchApp } from './support/launch';
import { makeSampleProject, runSampleTests, sampleGit } from './support/sample-project';

const MODE = process.env['INSECTOIDS_DEMO2'];
const REAL = MODE === 'real';
const MIN = 60_000;

test.skip(MODE !== 'real' && MODE !== 'fake', 'Phase 2 demo runs only with INSECTOIDS_DEMO2=real or fake.');

/** The local model (Ollama) for light work; a copy of qwen3:8b with a 16k context window. */
const LOCAL_MODEL = process.env['INSECTOIDS_DEMO2_LOCAL_MODEL'] ?? 'qwen3-8b-16k';
const OLLAMA_BASE = 'http://127.0.0.1:11434/v1';

/**
 * One line (the Queen reads the goal's first line as its title). It steers the plan into two waves across
 * three castes, with three similar low-priority example cards: repeated work (a skill proposal) that a free
 * local model can do. The scripted engine plans the same shape for this text (harness demo.ts DEMO_PHASE2_GOAL).
 */
export const PHASE2_GOAL = [
  'Add two functions to tiny-text: truncate(text, n), which returns the text unchanged when it has at most n characters and otherwise its first n - 1 characters followed by "…",',
  'and capitalize(text), which upper-cases the first letter and leaves the rest as it is.',
  'Export both from src/index.js and add node:test tests in test/.',
  'Plan it in two waves. Wave 1: one coder card for both functions (normal priority) and one tester card for their tests.',
  'Wave 2: three separate low priority documenter cards, one per function, each writing one short usage example file:',
  'docs/examples/wordcount.md for wordCount, docs/examples/capitalize.md for capitalize and docs/examples/truncate.md for truncate.',
  'Keep the library dependency-free; `node --test` must pass.',
].join(' ');

/** Asked after the goal, in other words than any record uses: only meaning search can find the truncate work. */
const MEANING_QUERY = 'shorten long strings';
const MODELS_DIR = process.env['APPDATA'] ? join(process.env['APPDATA'], 'The Insectoids', 'models') : '';
const MODEL_FILE = join(MODELS_DIR, 'all-MiniLM-L6-v2', '751bff37182d3f1213fa05d7196b954e230abad9', 'onnx', 'model_quantized.onnx');
const haveMeaningModel = Boolean(MODELS_DIR) && existsSync(MODEL_FILE);

const runDir = join(
  fileURLToPath(new URL('../../..', import.meta.url)),
  'demo-runs',
  `${new Date().toISOString().replace(/[:.]/g, '-')}-phase2${REAL ? '' : '-fake'}`,
);
const shot = (win: Page, name: string) => win.screenshot({ path: join(runDir, 'screens', `${name}.png`) });

const snap = (win: Page): Promise<HiveSnapshot> => win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.snapshot());
const cmd = (win: Page, c: Parameters<AppWindow['insectoids']['hive']['command']>[0]) =>
  win.evaluate(async (x) => {
    const r = await (globalThis as unknown as AppWindow).insectoids.hive.command(x);
    if (!r.ok) throw new Error(`${x.type}: ${r.error}`);
  }, c);
const go = (win: Page, name: string | RegExp) => win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click();

const lastActivity = (s: HiveSnapshot): string => s.activity.slice(-15).map((a) => `- ${a.message}`).join('\n');

/** Polls the snapshot until `pick` returns something, failing early if the goal gets stuck. */
async function waitFor<T>(win: Page, what: string, timeoutMs: number, pick: (s: HiveSnapshot) => T | undefined | null | false): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await snap(win);
    const hit = pick(s);
    if (hit) return hit;
    const goal = s.goals[0];
    if (goal && (goal.status === 'stuck' || goal.status === 'cancelled')) {
      throw new Error(`Goal ${goal.status} while waiting for ${what}. Last activity:\n${lastActivity(s)}`);
    }
    if (s.hive.paused && s.hive.pausedReason?.startsWith('Watchdog')) {
      throw new Error(`The Watchdog paused the hive while waiting for ${what}: ${s.hive.pausedReason}\nLast activity:\n${lastActivity(s)}`);
    }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}. Last activity:\n${lastActivity(s)}`);
    await win.waitForTimeout(REAL ? 3000 : 300);
  }
}

const waiting = (s: HiveSnapshot, kind: string) => s.approvals.find((a) => a.status === 'waiting' && a.kind === kind);

/** Real mode: both engines must be able to work before any tokens are spent. */
async function readyEngines(win: Page): Promise<{ claude: string; opencode: string; provider: string }> {
  const engines = await waitFor(win, 'the engine checks', 3 * MIN, (s) => !s.engines.some((e) => e.state === 'checking') && s.engines);
  const claude = engines.find((e) => e.id === 'claude');
  if (claude?.state !== 'ready') {
    throw new Error(
      claude?.state === 'signed-out'
        ? `Claude Code is not signed in: run \`claude\` once in a terminal and sign in, then run the demo again. (${claude.message})`
        : `Claude Code is not ready (${claude?.state ?? 'not listed'}): ${claude?.message ?? ''}`,
    );
  }

  // The local model for light work: an Ollama provider through OpenCode (no key; nothing leaves the PC).
  const provider = await win.evaluate(
    async ({ base, model }) => {
      const p = (globalThis as unknown as AppWindow).insectoids.providers;
      const existing = (await p.list()).find((x) => x.preset === 'ollama');
      const id = existing?.id ?? 'ollama-local';
      const saved = await p.save({ id, label: 'Ollama (this PC)', preset: 'ollama', baseUrl: base, secretRef: null, models: { strongest: model, standard: model, light: model }, enabled: true });
      if (!saved.ok) throw new Error(`Saving the Ollama provider failed: ${saved.error}`);
      const tested = await p.test(id);
      if (!tested.ok) throw new Error(`The Ollama provider test failed: ${tested.message} (is Ollama running, with the model "${model}"?)`);
      if (!tested.models.includes(model)) throw new Error(`Ollama doesn't list "${model}". It lists: ${tested.models.join(', ')}`);
      await p.setEnabled(id, true);
      return `${id}: ${tested.message}`;
    },
    { base: OLLAMA_BASE, model: LOCAL_MODEL },
  );
  const opencode = await waitFor(win, 'OpenCode to be ready with the local model', 3 * MIN, (s) => {
    const e = s.engines.find((x) => x.id === 'opencode');
    return e?.state === 'ready' && e;
  }).catch(async (err: unknown) => {
    const e = (await snap(win)).engines.find((x) => x.id === 'opencode');
    throw new Error(`OpenCode is not ready: ${e?.state ?? 'not listed'}: ${e?.message ?? ''}. ${err instanceof Error ? err.message.split('\n')[0] : ''}`);
  });
  if (/read-only work only/.test(opencode.message)) throw new Error(`OpenCode can't change files here: ${opencode.message}`);
  if (!opencode.enabled) await cmd(win, { type: 'setEngineEnabled', engineId: 'opencode', enabled: true });
  return { claude: `${claude.version ?? ''} ${claude.message}`.trim(), opencode: opencode.message, provider };
}

test('Phase 2 demo: the full hive across two engines', async () => {
  test.setTimeout(REAL ? 120 * MIN : 4 * MIN);
  mkdirSync(join(runDir, 'screens'), { recursive: true });
  const repo = makeSampleProject(join(runDir, 'tiny-text'));
  const base = sampleGit(repo, 'rev-parse', 'HEAD').trim();
  const timings: Record<string, number> = {};
  const t0 = Date.now();
  const mark = (k: string) => (timings[k] = Math.round((Date.now() - t0) / 1000));

  const { win, close } = await launchApp({
    repo,
    env: { INSECTOIDS_ENGINE: REAL ? 'claude' : 'fake', ...(haveMeaningModel ? { INSECTOIDS_E2E_MODEL_DIR: MODELS_DIR } : {}) },
  });
  try {
    await win.setViewportSize({ width: 1440, height: 900 });
    await expect(win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    const engines = REAL ? await readyEngines(win) : { claude: 'scripted', opencode: 'scripted', provider: 'none (fake mode)' };
    mark('enginesReady');
    await go(win, 'Connections');
    await win.waitForTimeout(1000);
    await shot(win, '00-connections-engines');

    // Balanced preset: multi-wave plans wait for approval (Hive 02-D11); merges always do.
    await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.setup.setPreset('balanced'));

    // The Brain finds things by meaning (B1): switch it on before the goal, so the goal's records get indexed.
    if (haveMeaningModel) await cmd(win, { type: 'setMeaningSearch', enabled: true });

    // 1. Give the Queen the goal (through the real composer).
    await go(win, 'Queen');
    const composer = win.getByRole('textbox').first();
    await composer.fill(PHASE2_GOAL);
    await composer.press('Enter');
    mark('goalSubmitted');

    // 2. (The Scout surveys first, when the code map is ready.) The Queen plans two waves; approve the plan.
    const plan = await waitFor(win, "the Queen's plan", 25 * MIN, (s) => waiting(s, 'plan'));
    mark('planReady');
    await win.waitForTimeout(800);
    await shot(win, '01-queen-plan');
    const planned = (await snap(win)).goals[0]!;
    await cmd(win, { type: 'approve', approvalId: plan.id });
    mark('planApproved');

    // 3. Insects work; the Inspector verifies. Pictures while they work.
    await waitFor(win, 'insects to start', 10 * MIN, (s) => s.hive.working > 0 || waiting(s, 'merge'));
    await go(win, 'Hive');
    await win.waitForTimeout(1500);
    await shot(win, '02-hive-working');
    await go(win, 'Taskboard');
    await win.waitForTimeout(800);
    await shot(win, '03-taskboard-working');

    // Guard "ask" approvals (risky actions) are approved for the demo and logged, so the run can finish.
    const approvedAsks: string[] = [];
    let sawLocalWork = false;
    const merge = await waitFor(win, 'the merge approval (every card done)', REAL ? 90 * MIN : 3 * MIN, (s) => {
      const ask = s.approvals.find((a) => a.status === 'waiting' && a.kind === 'risky_action');
      if (ask) {
        approvedAsks.push(`${ask.title} — ${ask.whyItNeedsYou}`);
        void cmd(win, { type: 'approve', approvalId: ask.id });
        return undefined;
      }
      if (!sawLocalWork && s.agents.some((a) => a.engine === 'opencode' && a.status === 'working')) {
        sawLocalWork = true;
        void go(win, 'Hive').then(() => win.waitForTimeout(1200)).then(() => shot(win, '04-hive-local-model-working'));
      }
      return waiting(s, 'merge');
    });
    mark('allCardsDone');
    await go(win, 'Taskboard');
    await win.waitForTimeout(800);
    await shot(win, '05-taskboard-done');

    // 4. Repeated work → a skill proposal (C3). The Librarian drafts it after the third similar card passes.
    const proposal = await waitFor(win, 'the skill proposal from repeated work', REAL ? 15 * MIN : MIN, (s) => waiting(s, 'skill_proposal'));
    mark('skillProposed');
    const draft = await win.evaluate(async (approvalId) => {
      const lib = (globalThis as unknown as AppWindow).insectoids.hive;
      const found = await lib.librarySearch({ statuses: ['draft'], limit: 50 });
      const item = found.items.find((i) => i.approvalId === approvalId) ?? null;
      return item ? { name: item.name, origin: item.origin, verdict: item.scan?.verdict ?? null, findings: item.scan?.findings.length ?? 0, description: item.description } : null;
    }, proposal.id);
    expect(draft, 'the proposal has a draft in the Library').not.toBeNull();
    expect(draft!.verdict === 'clean' || draft!.verdict === 'warn', `a learned skill is never blocked (got ${String(draft!.verdict)})`).toBe(true);
    await go(win, /^Approvals/);
    await win.waitForTimeout(800);
    await shot(win, '06-skill-proposal');
    await cmd(win, { type: 'approve', approvalId: proposal.id });
    let afterApprove: string | null = null;
    for (let i = 0; i < 20 && afterApprove !== 'ready'; i++) {
      afterApprove = await win.evaluate(async (name) => (await (globalThis as unknown as AppWindow).insectoids.hive.libraryItem(name))?.item.status ?? null, draft!.name);
      if (afterApprove !== 'ready') await win.waitForTimeout(500);
    }
    expect(afterApprove, 'approved learned skill is Ready').toBe('ready');
    mark('skillApproved');
    await go(win, 'Library');
    await win.waitForTimeout(800);
    await shot(win, '07-library-learned-skill');

    // 5. Approve the merge into main; the project's tests must pass on main.
    await go(win, 'Changes');
    await win.waitForTimeout(1000);
    await shot(win, '08-changes');
    await cmd(win, { type: 'approve', approvalId: merge.id });
    await waitFor(win, 'the merge', 3 * MIN, (s) => s.goals[0]?.merge === 'merged');
    mark('merged');
    const filesMerged = sampleGit(repo, 'diff', '--name-status', base, 'main').trim();
    expect(filesMerged, 'the merge changed main').not.toBe('');
    const testsOnMain = runSampleTests(repo);
    if (REAL) expect(testsOnMain.ok, `node --test on main after the merge:\n${testsOnMain.output}`).toBe(true);

    // 6. The Brain finds the work by meaning (B1): a question in other words than any record uses.
    let meaning: { query: string; state: string; hits: Array<{ title: string; kind: string; match: string }> } | null = null;
    if (haveMeaningModel) {
      await waitFor(win, 'meaning search to index the new records', 5 * MIN, (s) => s.meaningSearch.state === 'ready' && s.meaningSearch.indexed >= s.meaningSearch.total && s.meaningSearch);
      const hits = await win.evaluate(async (query) => (await (globalThis as unknown as AppWindow).insectoids.hive.brainSearch({ query })).slice(0, 8), MEANING_QUERY);
      meaning = { query: MEANING_QUERY, state: (await snap(win)).meaningSearch.state, hits: hits.map((h) => ({ title: h.title, kind: h.kind, match: h.match })) };
      const byMeaning = hits.filter((h) => (h.match === 'meaning' || h.match === 'both') && /truncat/i.test(`${h.title} ${h.summary ?? ''}`));
      expect(byMeaning.length, `"${MEANING_QUERY}" finds the truncate work by meaning. Hits:\n${hits.map((h) => `- [${h.match}] ${h.title}`).join('\n')}`).toBeGreaterThan(0);
      await go(win, 'Brain');
      await win.getByTestId('brain-search').fill(MEANING_QUERY);
      await win.waitForTimeout(1500);
      await shot(win, '09-brain-meaning-search');
    }

    // Routing by cost and history: every run's engine, model and the Treasurer's reason.
    const end = await snap(win);
    const budgets = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.budgets());
    const runs = end.agents.map((a) => ({
      agent: a.agentId,
      role: a.role,
      caste: a.caste,
      task: a.title,
      engine: a.engine,
      model: a.model,
      effort: a.effort,
      reason: a.routeReason,
      status: a.status,
      tokens: a.tokens,
      costUsd: a.costUsd,
      seconds: a.endedAt ? Math.round((a.endedAt - a.startedAt) / 1000) : null,
    }));
    const castes = [...new Set(end.cards.map((c) => c.caste))];
    expect(castes.length, `3+ castes worked (${castes.join(', ')})`).toBeGreaterThanOrEqual(3);
    expect(planned.plan?.waves.length ?? 0, 'a multi-wave plan').toBeGreaterThanOrEqual(2);
    expect(end.cards.every((c) => c.status === 'done'), 'every card reached done').toBe(true);
    const enginesUsed = [...new Set(budgets.routing.map((r) => r.engine).filter(Boolean))];
    if (REAL) {
      expect(enginesUsed, 'Claude Code did some of the work').toContain('claude');
      expect(enginesUsed, 'the free local model (OpenCode + Ollama) did some of the work').toContain('opencode');
    }

    await go(win, 'Budgets');
    await win.waitForTimeout(1000);
    await shot(win, '10-budgets-routing');
    await go(win, 'Hive');
    await win.waitForTimeout(800);
    await shot(win, '11-hive-done');
    await go(win, 'Queen');
    await win.waitForTimeout(800);
    await shot(win, '12-queen-done');

    const goal = end.goals[0]!;
    writeFileSync(
      join(runDir, 'summary.json'),
      `${JSON.stringify(
        {
          mode: MODE,
          goalText: PHASE2_GOAL,
          engines,
          goal: { title: goal.title, status: goal.status, merge: goal.merge, spentTokens: goal.spentTokens, spentUsd: goal.spentUsd, budgetTokens: goal.budgetTokens },
          plan: planned.plan,
          castes,
          enginesUsed,
          cards: end.cards.map((c) => ({ id: c.id, title: c.title, caste: c.caste, priority: c.priority, wave: c.wave, status: c.status, attempts: c.attempts, skills: c.skills })),
          runs,
          routing: budgets.routing.map((r) => ({ role: r.role, card: r.cardId, engine: r.engine, model: r.model, effort: r.effort, rule: r.rule, outcome: r.outcome, tokens: r.tokens, costUsd: r.costUsd })),
          learnedByTreasurer: budgets.learned,
          skillProposal: { approval: proposal.title, ...draft, statusAfterApproval: afterApprove },
          meaningSearch: meaning ?? { skipped: 'the meaning model is not on this PC (tests never download it)' },
          approvedAsks,
          filesMerged: filesMerged.split('\n'),
          testsOnMain: { ok: testsOnMain.ok },
          incidents: end.incidents.map((i) => `${i.step} · ${i.sensor} · ${i.agentId}: ${i.evidence}`),
          timingsSeconds: timings,
          sampleProject: repo,
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(runDir, 'activity.md'), `# Activity\n\n${end.activity.map((a) => `- ${new Date(a.at).toISOString().slice(11, 19)} ${a.message}`).join('\n')}\n`);
    for (const a of end.agents) writeFileSync(join(runDir, `output-${a.runId.replace(/[^\w.-]/g, '_')}.log`), `${a.agentId} · ${a.engine ?? '?'} · ${a.model ?? '?'} · ${a.title}\n${a.routeReason ?? ''}\n\n${a.output.join('\n')}\n`);
  } catch (err) {
    await shot(win, 'zz-failure').catch(() => {});
    const s = await snap(win).catch(() => null);
    if (s) writeFileSync(join(runDir, 'failure-snapshot.json'), JSON.stringify(s, null, 2));
    throw err;
  } finally {
    await close();
  }
});
