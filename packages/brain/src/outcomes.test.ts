import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Brain, type RunOutcome, openBrain } from './index';

let brain: Brain;
let clock: number;

beforeEach(() => {
  clock = 100_000_000;
  brain = openBrain(':memory:', { now: () => clock });
});
afterEach(() => brain.close());

const run = (o: Partial<RunOutcome> & { runId: string }): Omit<RunOutcome, 'at'> => ({
  goalId: 'G1',
  cardId: 'G1.C-01',
  role: 'coder',
  priority: 'normal',
  engine: 'claude',
  tier: 'standard',
  model: 'claude-sonnet',
  effort: 'medium',
  attempt: 0,
  result: 'pending',
  tokensIn: 100,
  tokensOut: 50,
  tokensCache: 10,
  costUsd: 0.1,
  costEstimated: false,
  durationMs: 2000,
  ...o,
});

describe('run outcomes (the Treasurer\'s memory, Phase 2 A5)', () => {
  it('records, reads back and replaces a run', () => {
    brain.outcomes.record(run({ runId: 'r1' }));
    expect(brain.outcomes.get('r1')).toMatchObject({ engine: 'claude', tier: 'standard', result: 'pending', at: 100_000_000, costEstimated: false });
    brain.outcomes.record(run({ runId: 'r1', result: 'error' }));
    expect(brain.outcomes.get('r1')?.result).toBe('error');
    expect(brain.outcomes.recent()).toHaveLength(1);
  });

  it('settles a card attempt\'s finished insect runs when the Inspector decides', () => {
    brain.outcomes.record(run({ runId: 'r1' }));
    brain.outcomes.record(run({ runId: 'r2', attempt: 1 }));
    brain.outcomes.record(run({ runId: 'r3', role: 'inspector' }));
    brain.outcomes.record(run({ runId: 'r4', result: 'limit' }));
    expect(brain.outcomes.settle('G1.C-01', 0, 'pass')).toBe(1);
    expect(brain.outcomes.get('r1')?.result).toBe('pass');
    expect(brain.outcomes.get('r2')?.result).toBe('pending');
    expect(brain.outcomes.get('r3')?.result).toBe('pending');
    expect(brain.outcomes.get('r4')?.result).toBe('limit');
  });

  it('learning stats count passes, and fails plus errors, never limits, sign-outs or stops', () => {
    for (let i = 0; i < 4; i++) brain.outcomes.record(run({ runId: `p${i}`, result: 'pass', costUsd: 0.1 + i * 0.1 }));
    brain.outcomes.record(run({ runId: 'f', result: 'fail' }));
    brain.outcomes.record(run({ runId: 'e', result: 'error' }));
    brain.outcomes.record(run({ runId: 'l', result: 'limit' }));
    brain.outcomes.record(run({ runId: 'a', result: 'auth' }));
    brain.outcomes.record(run({ runId: 's', result: 'stopped' }));
    brain.outcomes.record(run({ runId: 'o', role: 'tester', result: 'pass' }));
    const [stat, ...rest] = brain.outcomes.stats('coder');
    expect(rest).toEqual([]);
    expect(stat).toMatchObject({ engine: 'claude', tier: 'standard', effort: 'medium', successes: 4, failures: 2 });
    expect(stat!.avgCostPerSuccess).toBeCloseTo(0.25);
  });

  it('sums an engine\'s usage over a rolling window', () => {
    brain.outcomes.record(run({ runId: 'old', at: clock - 6 * 3600_000 }));
    brain.outcomes.record(run({ runId: 'new1' }));
    brain.outcomes.record(run({ runId: 'new2', costUsd: 0.4, costEstimated: true }));
    brain.outcomes.record(run({ runId: 'other', engine: 'opencode' }));
    expect(brain.outcomes.usageSince('claude', clock - 5 * 3600_000)).toEqual({ runs: 2, tokens: 320, costUsd: 0.5, costEstimated: true });
    expect(brain.outcomes.usageSince('claude', 0).runs).toBe(3);
    expect(brain.outcomes.usageSince('gemini', 0)).toEqual({ runs: 0, tokens: 0, costUsd: 0, costEstimated: false });
  });
});

describe('releasing a card without using an attempt', () => {
  it('puts the card back on the board with its attempts unchanged, for its holder only', () => {
    brain.goals.create({ id: 'G1', title: 'g', text: 'g', shelf: 's' });
    brain.taskboard.post({ id: 'G1.C-01', goalId: 'G1', wave: 1, title: 'Card', brief: 'b', caste: 'coder', priority: 'normal', acceptance: ['ok'], dependsOn: [] });
    brain.taskboard.claim('G1.C-01', { agentId: 'Ant-01', caste: 'coder', leaseMs: 60_000 });
    brain.taskboard.start('G1.C-01', 'Ant-01');
    expect(() => brain.taskboard.release('G1.C-01', 'Ant-02', 'x')).toThrow();
    const c = brain.taskboard.release('G1.C-01', 'Ant-01', 'Claude Code hit its usage limit');
    expect(c).toMatchObject({ status: 'open', attempts: 0 });
    expect(c.claimedBy).toBeUndefined();
    expect(brain.taskboard.events('G1.C-01').at(-1)).toMatchObject({ from: 'in_progress', to: 'open', note: 'Claude Code hit its usage limit' });
  });
});
