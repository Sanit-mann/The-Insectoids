import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { Workspace } from '@insectoids/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALL_CASTES } from './catalog';
import { demoEngine } from './demo';
import { type EngineRequest, FakeEngine, type FakeReply } from './engine';
import { Hive, type HiveEvent, type HiveOptions } from './hive';
import { parseForemanReply, parseReviewReply, reviewSummary, surveyFrom } from './managers';
import { Library } from './prompts';
import { routeCard } from './router';

/** The managers' brain side (Hive 02-D8, D9 P3, D12; Phase 2 C2): Watchdog, Foreman, Scout, reviews. */
const library = new Library(fileURLToPath(new URL('../../../../library', import.meta.url)));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const json = (v: unknown): string => `\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;
const plan = (cards: Array<Record<string, unknown>>): FakeReply => ({ text: json({ summary: 'S', waves: [{ cards }] }) });
const coder = (id: string, title = `Card ${id}`) => ({ id, title, brief: `Do ${id}.`, caste: 'coder', acceptance: [`${id} works`] });
const FAST = { queenMs: 1, insectMs: 5, inspectorMs: 1 };

let root: string;
let repo: string;
let brain: Brain;
let ws: Workspace;
let events: HiveEvent[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-managers-'));
  repo = join(root, 'project');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'user.email', 'user@example.com');
  writeFileSync(join(repo, 'README.md'), '# Site\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  brain = openBrain(':memory:');
  ws = new Workspace({ repoDir: repo, worktreesRoot: join(root, 'worktrees') });
  events = [];
});

afterEach(async () => {
  await ws.dispose();
  brain.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const makeHive = (engine: FakeEngine, extra: Partial<HiveOptions> = {}) =>
  new Hive({
    brain, workspace: ws, engine, library, repoDir: repo, dataDir: join(root, 'data'), shelf: 'site', home: join(root, 'home'),
    models: { strongest: 'opus', standard: 'sonnet', light: 'haiku' }, insectCap: 2, castes: [...ALL_CASTES], leaseMs: 60_000,
    onEvent: (e) => events.push(e), ...extra,
  });

describe('Watchdog breaker ladder in the hive', () => {
  it('"Loop on purpose": warn, then pause the card; the Foreman gives one more try with a note; it passes', async () => {
    const engine = demoEngine(FAST);
    const hive = makeHive(engine);
    const goal = await hive.submitGoal('Loop on purpose');
    await hive.runUntilIdle();

    const incidents = brain.incidents.list();
    expect(incidents.map((i) => `${i.sensor}:${i.step}`).reverse()).toEqual(['loop:warn', 'loop:pause-card']);
    expect(incidents[0]!.cardId).toBe(`${goal.id}.C-01`);
    expect(incidents[0]!.evidence).toContain('npm test');

    const decisions = brain.foreman.list();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ action: 'retry-with-note', wake: 'held', cardTitle: 'Loop on purpose' });
    const card = brain.taskboard.get(`${goal.id}.C-01`)!;
    expect(card.status).toBe('done');
    expect(card.heldReason).toBeNull();
    expect(card.foremanRetries).toBe(1);
    // The retry carried the Foreman's note in its brief.
    const retry = engine.calls.filter((c) => c.role === 'coder').at(-1)!;
    expect(retry.task).toContain("The Foreman's note");
    expect(retry.task).toContain('Run the command once');
    expect(events.some((e) => e.type === 'card-held')).toBe(true);
    expect(events.filter((e) => e.type === 'watchdog')).toHaveLength(2);
    expect(brain.approvals.list({ status: 'waiting' }).some((a) => a.kind === 'merge')).toBe(true);
  });

  it('a second crash on one card is a hard stop: the card is held for the Foreman', async () => {
    let crashes = 0;
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') return plan([coder('C-01')]);
      if (req.role === 'foreman') return { text: json({ action: 'to-queen', reason: 'It keeps crashing; the environment looks broken.' }) };
      if (req.role === 'inspector') return { text: 'VERDICT: PASS' };
      crashes++;
      return { text: '', ok: false, error: 'crash' };
    });
    const hive = makeHive(engine);
    const goal = await hive.submitGoal('Crash please');
    await hive.runUntilIdle();
    expect(crashes).toBe(2);
    expect(brain.incidents.list().map((i) => `${i.sensor}:${i.step}`).reverse()).toEqual(['crash:warn', 'crash:stop-agent']);
    expect(brain.foreman.list()[0]).toMatchObject({ wake: 'held', action: 'to-queen' });
    expect(brain.goals.get(goal.id)!.status).toBe('stuck');
    expect(events.find((e) => e.type === 'goal-stuck')!.message).toMatch(/^Foreman: It keeps crashing/);
  });

  it('a stalled insect is warned, then its card is held', async () => {
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') return plan([coder('C-01')]);
      if (req.role === 'foreman') return { text: json({ action: 'to-queen', reason: 'Stalls twice.' }) };
      // Silent for a long time: no events at all.
      return { text: 'STATUS: DONE', delayMs: 400 };
    });
    const hive = makeHive(engine, { watchdog: { stallMs: 120 } });
    await hive.submitGoal('Stall please');
    await hive.runUntilIdle();
    expect(brain.incidents.list().map((i) => `${i.sensor}:${i.step}`).reverse().slice(0, 2)).toEqual(['stall:warn', 'stall:pause-card']);
  });

  it('three serious trips within the window pause the hive', async () => {
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') return plan([coder('C-01'), coder('C-02'), coder('C-03')]);
      if (req.role === 'foreman') return { text: json({ action: 'to-queen', reason: 'Loops.' }) };
      const call = { kind: 'tool_use' as const, id: 't', name: 'Bash', input: { command: 'ls' } };
      return { text: 'STATUS: DONE', delayMs: 5, eventGapMs: 5, events: Array.from({ length: 12 }, () => call) };
    });
    const hive = makeHive(engine, { insectCap: 3 });
    await hive.submitGoal('Three loops');
    await hive.runUntilIdle();
    expect(hive.paused).toBe(true);
    const hiveTrip = brain.incidents.list().find((i) => i.sensor === 'hive');
    expect(hiveTrip?.step).toBe('pause-hive');
    expect(events.some((e) => e.type === 'paused' && e.message.startsWith('Watchdog:'))).toBe(true);
  });

  it('the Queen looping pauses the hive with an alert (02-D12)', async () => {
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') {
        const call = { kind: 'tool_use' as const, id: 't', name: 'Read', input: { file_path: 'README.md' } };
        return { text: json({ summary: 'S', waves: [{ cards: [coder('C-01')] }] }), delayMs: 5, eventGapMs: 5, events: Array.from({ length: 12 }, () => call) };
      }
      return { text: 'STATUS: DONE' };
    });
    const hive = makeHive(engine);
    const goal = await hive.submitGoal('Plan please');
    expect(hive.paused).toBe(true);
    expect(brain.goals.get(goal.id)!.status).toBe('stuck');
    expect(brain.incidents.list()[0]).toMatchObject({ agentId: 'Queen', step: 'pause-hive' });
  });

  it('a run over the hard token cap is stopped and its work not kept', async () => {
    let n = 0;
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') return plan([coder('C-01')]);
      if (req.role === 'inspector') return { text: 'VERDICT: PASS' };
      return { text: 'STATUS: DONE', tokens: ++n === 1 ? 5_000 : 100, effects: (cwd) => writeFileSync(join(cwd, `a${n}.txt`), 'x') };
    });
    const hive = makeHive(engine, { watchdog: { hardRunTokens: 1_000 } });
    const goal = await hive.submitGoal('Spend too much');
    await hive.runUntilIdle();
    expect(brain.incidents.list()[0]).toMatchObject({ sensor: 'overspend', step: 'stop-agent' });
    const card = brain.taskboard.get(`${goal.id}.C-01`)!;
    expect(card.status).toBe('done');
    expect(card.attempts).toBe(1);
  });

  it('nothing trips on ordinary work', async () => {
    const hive = makeHive(demoEngine(FAST));
    await hive.submitGoal('Write the welcome docs');
    await hive.runUntilIdle();
    expect(brain.incidents.list()).toEqual([]);
    expect(brain.foreman.list()).toEqual([]);
  });
});

describe('the Foreman brain', () => {
  it('"Fail on purpose": out of attempts, the Foreman sends it to the Queen; the goal is stuck with its reason', async () => {
    const engine = demoEngine(FAST);
    const hive = makeHive(engine);
    const goal = await hive.submitGoal('Fail on purpose');
    await hive.runUntilIdle();
    expect(brain.foreman.list()[0]).toMatchObject({ wake: 'attempts-exhausted', action: 'to-queen' });
    expect(brain.goals.get(goal.id)!.status).toBe('stuck');
    expect(events.find((e) => e.type === 'goal-stuck')!.message).toMatch(/^Foreman: The Inspector rejected it/);
    expect(engine.calls.filter((c) => c.role === 'foreman')).toHaveLength(1);
  });

  it('a stronger-model retry gives one extra attempt on the strongest tier; a second failure goes to the Queen without asking again', async () => {
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') return plan([coder('C-01')]);
      if (req.role === 'foreman') return { text: json({ action: 'stronger-model', reason: 'Too hard for the standard model.' }) };
      if (req.role === 'inspector') return { text: 'VERDICT: FAIL: still wrong' };
      return { text: 'STATUS: DONE', effects: (cwd) => writeFileSync(join(cwd, `x${Math.random()}.txt`), 'x') };
    });
    const hive = makeHive(engine);
    const goal = await hive.submitGoal('Hard card');
    await hive.runUntilIdle();
    const coders = engine.calls.filter((c) => c.role === 'coder');
    expect(coders).toHaveLength(4);
    expect(coders.at(-1)!.route.tier).toBe('strongest');
    expect(engine.calls.filter((c) => c.role === 'foreman')).toHaveLength(1);
    expect(brain.foreman.list().map((d) => d.action)).toEqual(['to-queen', 'stronger-model']);
    expect(brain.goals.get(goal.id)!.status).toBe('stuck');
  });

  it('a malformed reply sends the card to the Queen', () => {
    expect(parseForemanReply('I think we should retry.').action).toBe('to-queen');
    expect(parseForemanReply(json({ action: 'retry-with-note', reason: 'Clear cause.' }))).toEqual({ action: 'retry-with-note', reason: 'Clear cause.', note: 'Clear cause.' });
    expect(parseForemanReply(json({ action: 'explode', reason: 'x' })).action).toBe('to-queen');
  });

  it('with the Foreman brain off, a failed card makes the goal stuck at once (Phase 1 behaviour)', async () => {
    const engine = demoEngine(FAST);
    const hive = makeHive(engine, { foremanBrain: false });
    const goal = await hive.submitGoal('Fail on purpose');
    await hive.runUntilIdle();
    expect(brain.goals.get(goal.id)!.status).toBe('stuck');
    expect(engine.calls.some((c) => c.role === 'foreman')).toBe(false);
    expect(brain.foreman.list()).toEqual([]);
  });

  it('the periodic review reads code-built metrics and reports through the caller', async () => {
    const engine = demoEngine(FAST);
    const hive = makeHive(engine);
    await hive.submitGoal('Write the welcome docs');
    await hive.runUntilIdle();
    const r = await hive.review(null);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('Hive review: 3 cards finished, 0 incidents since the last review. Nothing needs changing.');
    const call = engine.calls.find((c) => c.role === 'foreman')!;
    expect(call.task).toContain('Cards finished since the last review: 3');
    expect(call.route.tier).toBe('standard');
  });

  it('reviewSummary and parseReviewReply', () => {
    const s = reviewSummary(brain, null);
    expect(s.text).toContain('Cards finished since the last review: 0');
    expect(parseReviewReply('no json here', s)).toBe('Hive review: 0 cards finished, 0 incidents since the last review.');
    expect(parseReviewReply(json({ report: 'Hive review: all good.' }), s)).toBe('Hive review: all good.');
  });
});

describe('the Scout', () => {
  const scout = (on = true, outline: string | null = 'src/app.ts: main()') => ({ enabled: () => on, outline: () => outline });

  it('surveys before the Queen plans a 6+ word goal; the survey reaches her and the Brain (unconfirmed)', async () => {
    const engine = demoEngine(FAST);
    const hive = makeHive(engine, { scout: scout() });
    await hive.submitGoal('Survey the code first, then say hello');
    const roles = engine.calls.map((c) => c.role);
    expect(roles.indexOf('scout')).toBeLessThan(roles.indexOf('queen'));
    const scoutCall = engine.calls.find((c) => c.role === 'scout')!;
    expect(scoutCall.task).toContain('src/app.ts: main()');
    expect(scoutCall.route.tier).toBe('light');
    expect(engine.calls.find((c) => c.role === 'queen')!.task).toContain("# The Scout's survey");
    const rec = brain.recent({ shelf: 'site', kinds: ['update'] }).find((h) => h.title.startsWith('Scout survey:'));
    expect(rec).toBeDefined();
    expect(brain.get(rec!.id)!.trust).toBe('unconfirmed');
  });

  it('stays out of short goals, when switched off, and when the code map is not ready', async () => {
    for (const [goal, s] of [
      ['Say hello', scout()],
      ['Survey the code first, then say hello', scout(false)],
      ['Survey the code first, then say hello', scout(true, null)],
    ] as const) {
      const engine = demoEngine(FAST);
      const hive = makeHive(engine, { scout: s });
      await hive.submitGoal(goal);
      expect(engine.calls.some((c) => c.role === 'scout')).toBe(false);
    }
  });

  it('a failed survey never blocks planning', async () => {
    const engine = new FakeEngine((req: EngineRequest) => {
      if (req.role === 'scout') return { text: '', ok: false, error: 'model-error' };
      if (req.role === 'queen') return plan([coder('C-01')]);
      return { text: 'STATUS: DONE' };
    });
    const hive = makeHive(engine, { scout: scout() });
    const goal = await hive.submitGoal('Survey the code first, then say hello');
    expect(goal.status).toBe('running');
    expect(events.some((e) => e.type === 'scout' && e.message.includes('plans without it'))).toBe(true);
    expect(surveyFrom('short')).toBeNull();
  });
});

describe('routing for the managers', () => {
  const models = { strongest: 'opus', standard: 'sonnet', light: 'haiku' };
  it('scout light, foreman standard low; minTier raises an insect', () => {
    expect(routeCard({ role: 'scout', priority: 'normal', attempts: 0 }, models).tier).toBe('light');
    expect(routeCard({ role: 'foreman', priority: 'normal', attempts: 0 }, models)).toMatchObject({ tier: 'standard', effort: 'low' });
    expect(routeCard({ role: 'coder', priority: 'low', attempts: 0, minTier: 'strongest' }, models).tier).toBe('strongest');
  });
});
