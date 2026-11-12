import { describe, expect, it } from 'vitest';
import { budgetState, routeCard, runTokens } from './router';

const models = { strongest: 'opus', standard: 'sonnet', light: 'haiku' };

describe('model + effort router (Hive 02-D9 P1, rule-based first)', () => {
  it('the Queen plans on the strongest model with high effort (02-D6)', () => {
    expect(routeCard({ role: 'queen', priority: 'normal', attempts: 0 }, models)).toMatchObject({ model: 'opus', effort: 'high' });
  });

  it('routine cards get the standard model at medium effort', () => {
    expect(routeCard({ role: 'coder', priority: 'normal', attempts: 0 }, models)).toMatchObject({ model: 'sonnet', effort: 'medium' });
  });

  it('low-priority cards use the light model; critical ones the strongest', () => {
    expect(routeCard({ role: 'tester', priority: 'low', attempts: 0 }, models)).toMatchObject({ model: 'haiku', effort: 'low' });
    expect(routeCard({ role: 'coder', priority: 'critical', attempts: 0 }, models)).toMatchObject({ model: 'opus', effort: 'high' });
  });

  it('a retry gets more effort, then a stronger model', () => {
    expect(routeCard({ role: 'coder', priority: 'normal', attempts: 1 }, models)).toMatchObject({ model: 'sonnet', effort: 'high' });
    expect(routeCard({ role: 'coder', priority: 'normal', attempts: 2 }, models)).toMatchObject({ model: 'opus', effort: 'high' });
    expect(routeCard({ role: 'coder', priority: 'critical', attempts: 3 }, models)).toMatchObject({ model: 'opus', effort: 'max' });
  });

  it('every run has hard limits (Watchdog)', () => {
    const r = routeCard({ role: 'coder', priority: 'normal', attempts: 0 }, models);
    expect(r.maxTurns).toBeGreaterThan(0);
    expect(r.maxBudgetUsd).toBeGreaterThan(0);
    expect(r.timeoutMs).toBeGreaterThan(0);
  });
});

describe('budgets (Treasurer reflex)', () => {
  it('counts the tokens a run really used (cache reads are cheap and not counted)', () => {
    expect(runTokens({ input: 100, output: 50, cacheRead: 100_000, cacheWrite: 2_000 })).toBe(2_150);
  });

  it('is ok, warns at 75%, stops at 100%', () => {
    expect(budgetState(100, 1_000)).toBe('ok');
    expect(budgetState(750, 1_000)).toBe('warn');
    expect(budgetState(1_000, 1_000)).toBe('stop');
    expect(budgetState(5_000, null)).toBe('ok');
  });
});
