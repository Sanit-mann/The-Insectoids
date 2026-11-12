import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, type OutcomeStat, openBrain } from '@insectoids/brain';
import { Workspace } from '@insectoids/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type EngineAdapter, EngineRegistry } from '../engines/registry';
import { detectUsageLimit, parseResetTime } from '../engines/limits';
import { type EngineRequest, FakeEngine, type FakeReply } from './engine';
import { Hive, type HiveLimits, LIMIT_PAUSE } from './hive';
import { Library } from './prompts';
import { type ModelTiers, type RouteInput, routeCard } from './router';
import { type LearnEngine, learnRoute, sampleBeta, seededRng } from './treasurer';

const claude: LearnEngine = { id: 'claude', name: 'Claude Code', models: { strongest: 'opus', standard: 'sonnet', light: 'haiku' }, efforts: ['low', 'medium', 'high', 'max'] };
const open: LearnEngine = { id: 'opencode', name: 'OpenCode', models: { strongest: 'big', standard: 'mid', light: 'small' }, efforts: null };
const coder: RouteInput = { role: 'coder', priority: 'normal', attempts: 0 };
const stat = (engine: string, tier: string, effort: string, successes: number, failures: number, avg: number | null = null): OutcomeStat => ({
  role: 'coder', engine, tier, effort, successes, failures, avgCostPerSuccess: avg,
});

describe('vendor usage limits', () => {
  const now = Date.UTC(2026, 10, 12, 10, 0, 0);
  it('spots limit messages and leaves ordinary failures alone', () => {
    for (const t of [
      'Claude AI usage limit reached|1767225600',
      "You've hit your limit · resets 3pm",
      'Error: 429 Too Many Requests',
      'status: 429',
      'RESOURCE_EXHAUSTED: Quota exceeded for quota metric',
      'Rate limit reached for requests',
    ]) expect(detectUsageLimit(t, now).limited, t).toBe(true);
    for (const t of ['TypeError: cannot read x', 'Tests failed on line 429', 'The model refused', '']) expect(detectUsageLimit(t, now).limited, t).toBe(false);
  });

  it('reads the reset time in the forms engines use', () => {
    expect(parseResetTime('Claude AI usage limit reached|1767225600', now)).toBe(1767225600_000);
    expect(parseResetTime('{"error":"rate","resetsAt":1767225600}', now)).toBe(1767225600_000);
    expect(parseResetTime('Rate limited, try again in 15 minutes', now)).toBe(now + 15 * 60_000);
    expect(parseResetTime('retry after 30 seconds', now)).toBe(now + 30_000);
    expect(parseResetTime('quota resets at 2026-11-12T18:00:00Z', now)).toBe(Date.UTC(2026, 10, 12, 18));
    const pm = parseResetTime('limit reached · resets 3pm', now)!;
    expect(new Date(pm).getHours()).toBe(15);
    expect(pm).toBeGreaterThan(now);
    expect(pm - now).toBeLessThanOrEqual(24 * 3600_000);
    expect(parseResetTime('usage limit reached', now)).toBeNull();
  });
});

describe('the learning router', () => {
  const rule = routeCard(coder, claude.models, 'claude');

  it('keeps the rule route until a way has enough finished runs', () => {
    const r = learnRoute({ input: coder, rule, engines: [claude], stats: [stat('claude', 'light', 'medium', 3, 0)], rng: seededRng(1) });
    expect(r).toBe(rule);
    expect(r.reason).toBe('rule: normal priority card');
  });

  it('chooses the cheapest way that is good enough', () => {
    const stats = [stat('claude', 'standard', 'medium', 10, 0, 0.3), stat('claude', 'light', 'medium', 19, 0, 0.05), stat('claude', 'strongest', 'medium', 10, 0, 1.2)];
    const r = learnRoute({ input: coder, rule, engines: [claude], stats, rng: seededRng(7) });
    expect(r).toMatchObject({ engine: 'claude', tier: 'light', model: 'haiku', effort: 'medium', maxBudgetUsd: 0.5 });
    expect(r.reason).toMatch(/^learned: Claude Code haiku·medium passed 19\/19 coder cards \(avg \$0\.05\), cheaper than the rule route$/);
  });

  it('takes the most likely to succeed when nothing is good enough', () => {
    const stats = [stat('claude', 'standard', 'medium', 2, 8), stat('claude', 'strongest', 'medium', 5, 5)];
    const r = learnRoute({ input: coder, rule, engines: [claude], stats, rng: seededRng(3) });
    expect(r.tier).toBe('strongest');
    expect(r.reason).toMatch(/^learned: nothing reached 80% yet/);
  });

  it('may move work to another allowed engine, and ignores engines it was not given', () => {
    const stats = [stat('opencode', 'standard', 'medium', 20, 0, 0.01), stat('claude', 'standard', 'medium', 20, 0, 0.4)];
    expect(learnRoute({ input: coder, rule, engines: [claude, open], stats, rng: seededRng(5) })).toMatchObject({ engine: 'opencode', model: 'mid' });
    // OpenCode not allowed (say, exhausted or switched off): its record is never used.
    expect(learnRoute({ input: coder, rule, engines: [claude], stats, rng: seededRng(5) }).engine).toBe('claude');
  });

  it('prefers an engine that is not near its cap when both are good enough', () => {
    const stats = [stat('opencode', 'standard', 'medium', 20, 0, 0.01), stat('claude', 'standard', 'medium', 20, 0, 0.4)];
    expect(learnRoute({ input: coder, rule, engines: [claude, { ...open, near: true }], stats, rng: seededRng(5) }).engine).toBe('claude');
  });

  it('never touches retries, the Queen or the Inspector', () => {
    const stats = [stat('claude', 'light', 'low', 50, 0, 0.01)];
    for (const input of [{ ...coder, attempts: 1 }, { role: 'queen' as const, priority: 'normal' as const, attempts: 0 }, { role: 'inspector' as const, priority: 'normal' as const, attempts: 0 }]) {
      const r = routeCard(input, claude.models, 'claude');
      expect(learnRoute({ input, rule: r, engines: [claude], stats, rng: seededRng(1) })).toBe(r);
    }
  });

  it('is repeatable with the same seed', () => {
    const stats = [stat('claude', 'standard', 'medium', 6, 2), stat('claude', 'light', 'medium', 6, 2), stat('claude', 'standard', 'low', 5, 3)];
    const pick = (seed: number) => learnRoute({ input: coder, rule, engines: [claude], stats, rng: seededRng(seed) });
    expect(pick(42)).toEqual(pick(42));
    const draws = Array.from({ length: 2000 }, (_, i) => sampleBeta(9, 1, seededRng(i)));
    expect(draws.reduce((a, b) => a + b, 0) / draws.length).toBeCloseTo(0.9, 1);
  });
});

describe('the registry with limits and learning', () => {
  const adapter = (id: 'claude' | 'opencode', name: string, models: ModelTiers): EngineAdapter => ({
    id, name, vendor: 'v', models, availableIn: null, install: null, signIn: null, privacyNote: null,
    capabilities: { guard: 'hook', mcp: true, effort: ['low', 'medium', 'high', 'max'], reportsCost: true },
    detect: async () => ({ state: 'ready', version: '1', message: 'ok' }),
    create: () => new FakeEngine(() => ({ text: 'x' })),
  });
  const make = async () => {
    const r = new EngineRegistry([adapter('claude', 'Claude Code', claude.models), adapter('opencode', 'OpenCode', open.models)]);
    await r.detectAll();
    return r;
  };

  it('routes around an exhausted engine and says why', async () => {
    const r = await make();
    r.setLimitState((id) => (id === 'claude' ? { exhausted: true, near: false, message: 'Claude Code is at its usage limit until 3:00 PM' } : null));
    const route = r.route(coder, routeCard);
    expect(route.engine).toBe('opencode');
    expect(route.reason).toBe('fallback: Claude Code is at its usage limit until 3:00 PM; rule: normal priority card');
    expect(r.canRoute('coder')).toBe(true);
    r.setLimitState(() => ({ exhausted: true, near: false, message: 'x' }));
    expect(r.canRoute('coder')).toBe(false);
  });

  it('prefers an engine that is not near its cap', async () => {
    const r = await make();
    r.setLimitState((id) => (id === 'claude' ? { exhausted: false, near: true, message: 'near' } : null));
    expect(r.route(coder, routeCard).engine).toBe('opencode');
  });

  it('learns from outcomes when learning is on', async () => {
    const r = await make();
    r.setLearning({ stats: () => [stat('claude', 'light', 'medium', 30, 0, 0.02), stat('claude', 'standard', 'medium', 30, 0, 0.3)], rng: seededRng(9) });
    expect(r.route(coder, routeCard)).toMatchObject({ engine: 'claude', model: 'haiku', reason: expect.stringMatching(/^learned:/) });
  });
});

// ---- the hive with limits ------------------------------------------------------------------------

const library = new Library(fileURLToPath(new URL('../../../../library', import.meta.url)));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
let root: string;
let repo: string;
let brain: Brain;
let ws: Workspace;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-treasurer-'));
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
});

afterEach(async () => {
  await ws.dispose();
  brain.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const plan: FakeReply = {
  text: `\`\`\`json\n${JSON.stringify({ summary: 'One card', waves: [{ cards: [{ id: 'C-01', title: 'Card C-01', brief: 'Do it', caste: 'coder', acceptance: ['works'] }] }] })}\n\`\`\``,
};

function hiveWith(engine: FakeEngine, limits?: HiveLimits): Hive {
  return new Hive({
    brain, workspace: ws, engine, library, repoDir: repo, dataDir: join(root, 'data'), shelf: 'site', home: join(root, 'home'),
    models: { strongest: 'opus', standard: 'sonnet', light: 'haiku' }, insectCap: 2, castes: ['coder'], leaseMs: 60_000,
    ...(limits ? { limits } : {}),
  });
}

describe('the hive and the Treasurer', () => {
  it('records every run, and settles insect runs with the Inspector\'s verdict', async () => {
    const engine = new FakeEngine((req: EngineRequest) => {
      if (req.role === 'queen') return plan;
      if (req.role === 'inspector') return { text: 'VERDICT: PASS' };
      return { text: 'STATUS: DONE', costUsd: 0.07, effects: (cwd) => writeFileSync(join(cwd, 'a.txt'), 'a') };
    });
    const hive = hiveWith(engine);
    await hive.submitGoal('Do one thing');
    await hive.runUntilIdle();
    const rows = brain.outcomes.recent();
    expect(rows.map((r) => `${r.role}:${r.result}`).sort()).toEqual(['coder:pass', 'inspector:pass', 'queen:pass']);
    expect(rows.find((r) => r.role === 'coder')).toMatchObject({ engine: 'claude', tier: 'standard', model: 'sonnet', effort: 'medium', costUsd: 0.07, attempt: 0 });
    expect(brain.outcomes.stats('coder')).toEqual([expect.objectContaining({ successes: 1, failures: 0 })]);
  });

  it('a vendor limit puts the card back without using an attempt, tells the Treasurer, and rests the hive when no engine is left', async () => {
    let limited = false;
    const hits: Array<{ engine: string; resetAt: number | null }> = [];
    const limits: HiveLimits = {
      hit: (engine, resetAt) => {
        hits.push({ engine, resetAt });
        limited = true;
      },
      canRoute: () => !limited,
    };
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') return plan;
      if (req.role === 'inspector') return { text: 'VERDICT: PASS' };
      return { text: 'Claude AI usage limit reached|1767225600', ok: false, error: 'model-error' };
    });
    const hive = hiveWith(engine, { ...limits, canRoute: (role) => role === 'queen' || !limited });
    await hive.submitGoal('Do one thing');
    await hive.tick();
    await hive.runUntilIdle(20);
    const card = brain.taskboard.list()[0]!;
    expect(card).toMatchObject({ status: 'open', attempts: 0 });
    expect(hits).toEqual([{ engine: 'claude', resetAt: 1767225600_000 }]);
    expect(hive.paused).toBe(true);
    expect(brain.outcomes.recent().find((r) => r.role === 'coder')?.result).toBe('limit');
    expect(brain.taskboard.events(card.id).some((e) => /usage limit/.test(e.note ?? ''))).toBe(true);
  });

  it('with another engine still free, the card is simply picked up again (no pause)', async () => {
    let calls = 0;
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') return plan;
      if (req.role === 'inspector') return { text: 'VERDICT: PASS' };
      calls++;
      return calls === 1
        ? { text: 'Error: 429 Too Many Requests', ok: false, error: 'crash' }
        : { text: 'STATUS: DONE', effects: (cwd) => writeFileSync(join(cwd, 'b.txt'), 'b') };
    });
    const hive = hiveWith(engine, { hit: () => {}, canRoute: () => true });
    await hive.submitGoal('Do one thing');
    await hive.runUntilIdle();
    expect(hive.paused).toBe(false);
    expect(brain.taskboard.list()[0]).toMatchObject({ status: 'done', attempts: 0 });
  });

  it('the Treasurer can lower the insect cap (an engine near its cap)', async () => {
    const twoCards: FakeReply = {
      text: `\`\`\`json\n${JSON.stringify({ summary: 'Two', waves: [{ cards: [1, 2].map((n) => ({ id: `C-0${n}`, title: `Card ${n}`, brief: 'b', caste: 'coder', acceptance: ['ok'] })) }] })}\n\`\`\``,
    };
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') return twoCards;
      if (req.role === 'inspector') return { text: 'VERDICT: PASS' };
      return { text: 'STATUS: DONE', delayMs: 50, effects: (cwd) => writeFileSync(join(cwd, `${req.agentId}.txt`), 'x') };
    });
    const hive = hiveWith(engine, { hit: () => {}, canRoute: () => true, cap: () => 1 });
    await hive.submitGoal('Two things');
    await hive.runUntilIdle();
    expect(engine.maxConcurrentInsects).toBe(1);
    expect(LIMIT_PAUSE).toBe('Usage limit:');
  });
});
