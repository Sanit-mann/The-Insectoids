import { describe, expect, it } from 'vitest';
import { SAMPLE_GOAL_TEXT } from './practice-project';
import { MIN_RUNS_PER_ROLE, type PastRun, TYPICAL_SMALL_GOAL, estimateSample } from './setup-sample';

/** The sample goal's estimate (Onboarding 08-D8; Phase 2 C5): shown before anything runs. */
const claude = { id: 'claude' as const, name: 'Claude Code', state: 'ready' as const, subscription: true };
const base = { engine: claude, busy: false, practicePath: '/data/practice-project' };
const runs = (role: string, tokens: number[], engine = 'claude', costUsd = 0): PastRun[] => tokens.map((t) => ({ role, engine, tokens: t, costUsd }));

describe('sample goal estimate', () => {
  it('uses a typical small goal until the hive has enough runs of its own', () => {
    const e = estimateSample({ ...base, runs: runs('queen', [5_000]) });
    expect(e).toMatchObject({ goalText: SAMPLE_GOAL_TEXT, tokensLow: TYPICAL_SMALL_GOAL.low, tokensHigh: TYPICAL_SMALL_GOAL.high, canRun: true, reason: null });
    expect(e.basis).toMatch(/typical small goal/);
    expect(e.engine).toBe('Claude Code');
    expect(e.practicePath).toBe('/data/practice-project');
  });

  it("uses the medians of this hive's own Queen, insect and Inspector runs when there are enough", () => {
    expect(MIN_RUNS_PER_ROLE).toBe(2);
    // Insect runs come by caste in the routing history ("coder", "tester"…).
    const past = [...runs('queen', [4_000, 6_000, 5_000]), ...runs('coder', [20_000]), ...runs('tester', [10_000]), ...runs('inspector', [2_000, 4_000]), ...runs('librarian', [99_000, 99_000])];
    const e = estimateSample({ ...base, runs: past });
    // medians 5k + 15k + 3k = 23k → low 0.8×, high 2.5× (rounded to 1k)
    expect(e.tokensLow).toBe(18_000);
    expect(e.tokensHigh).toBe(58_000);
    expect(e.basis).toMatch(/last 7 runs/);
  });

  it('has no per-token price on a subscription engine, and says it counts toward its limits', () => {
    const e = estimateSample({ ...base, runs: [] });
    expect([e.costUsdLow, e.costUsdHigh]).toEqual([null, null]);
    expect(e.note).toBe('Uses your Claude Code subscription; no extra charge, it counts toward its usage limits.');
  });

  it('reads the subscription from the engine, not from a list of ids', () => {
    // A new plan engine (e.g. a Copilot preset) gets the subscription wording with no change here.
    const copilot = estimateSample({ ...base, engine: { id: 'copilot', name: 'GitHub Copilot CLI', state: 'ready', subscription: true }, runs: [] });
    expect(copilot.note).toBe('Uses your GitHub Copilot CLI subscription; no extra charge, it counts toward its usage limits.');
    expect([copilot.costUsdLow, copilot.costUsdHigh]).toEqual([null, null]);
    // And an engine that does not say it is on a plan is never assumed to be, even with a familiar id.
    const unmarked = estimateSample({ ...base, engine: { id: 'claude', name: 'Claude Code', state: 'ready' }, runs: [] });
    expect(unmarked.note).toMatch(/Billed by your API provider per token/);
  });

  it("prices an API provider engine from its own past runs' reported cost", () => {
    const opencode = { id: 'opencode' as const, name: 'OpenCode', state: 'ready' as const };
    const past = [...runs('queen', [10_000, 10_000], 'opencode', 0.02), ...runs('insect', [10_000, 10_000], 'opencode', 0.02), ...runs('inspector', [10_000, 10_000], 'opencode', 0.02)];
    const e = estimateSample({ ...base, engine: opencode, runs: past });
    // $2 per million tokens; 30k median sum → 24k–75k tokens → $0.05–$0.15
    expect(e.costUsdLow).toBe(0.05);
    expect(e.costUsdHigh).toBe(0.15);
    expect(e.note).toMatch(/about \$2 per million tokens/);
    const unpriced = estimateSample({ ...base, engine: opencode, runs: [] });
    expect(unpriced.costUsdLow).toBeNull();
    expect(unpriced.note).toMatch(/no past runs on it to price this yet/);
  });

  it('says the scripted test engine spends nothing', () => {
    const e = estimateSample({ ...base, engine: { id: 'fake', name: 'Test engine', state: 'fake' }, runs: [] });
    expect(e.note).toMatch(/spends no tokens/);
    expect(e.canRun).toBe(true);
  });

  it("can't run without a ready engine, or while the hive is busy, and says why", () => {
    const none = estimateSample({ ...base, engine: null, runs: [] });
    expect(none).toMatchObject({ canRun: false, engine: null });
    expect(none.reason).toMatch(/No AI engine is ready yet/);
    const busy = estimateSample({ ...base, busy: true, runs: [] });
    expect(busy.canRun).toBe(false);
    expect(busy.reason).toMatch(/working on a goal right now/);
  });
});
