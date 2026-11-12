import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Brain, openBrain } from './brain';

let brain: Brain;
let clock: number;
beforeEach(() => {
  clock = 5_000;
  let n = 0;
  brain = openBrain(':memory:', { now: () => clock, newId: () => `id${++n}` });
});
afterEach(() => brain.close());

describe('goals', () => {
  it('creates a goal in planning and records it', () => {
    const g = brain.goals.create({ title: 'Contact form', text: 'Add a contact form with tests', shelf: 'site' });
    expect(g).toMatchObject({ status: 'planning', currentWave: 0, spentTokens: 0, spentUsd: 0 });
    expect(brain.goals.get(g.id)?.title).toBe('Contact form');
  });

  it('moves through its lifecycle and refuses illegal moves', () => {
    const g = brain.goals.create({ title: 't', text: 'x', shelf: 's' });
    brain.goals.setStatus(g.id, 'awaiting_approval');
    brain.goals.setStatus(g.id, 'running');
    expect(() => brain.goals.setStatus(g.id, 'planning')).toThrow(/running -> planning/);
    brain.goals.setStatus(g.id, 'done');
    expect(() => brain.goals.setStatus(g.id, 'running')).toThrow();
  });

  it('stores the plan and the current wave', () => {
    const g = brain.goals.create({ title: 't', text: 'x', shelf: 's' });
    brain.goals.setPlan(g.id, { summary: 'Two waves', waves: [] });
    brain.goals.setWave(g.id, 1);
    expect(brain.goals.get(g.id)).toMatchObject({ plan: { summary: 'Two waves' }, currentWave: 1 });
  });

  it('adds up what the goal has spent', () => {
    const g = brain.goals.create({ title: 't', text: 'x', shelf: 's', budgetTokens: 1_000 });
    brain.goals.addSpend(g.id, 300, 0.01);
    brain.goals.addSpend(g.id, 200, 0.02);
    expect(brain.goals.get(g.id)).toMatchObject({ spentTokens: 500, spentUsd: 0.03, budgetTokens: 1_000 });
  });
});

describe('approvals (Hive 02-D7, Memory 01-D3)', () => {
  const ask = () =>
    brain.approvals.create({
      goalId: 'G-1',
      kind: 'merge',
      title: 'Merge goal into main',
      from: 'Inspector',
      whyItNeedsYou: 'Your main branch changes only with your approval.',
      ifYouSayYes: 'The hive branch is merged into main.',
      payload: { goalId: 'G-1' },
    });

  it('waits for the user', () => {
    const a = ask();
    expect(a).toMatchObject({ status: 'waiting', destructive: false });
    expect(brain.approvals.list({ status: 'waiting' }).map((x) => x.id)).toEqual([a.id]);
  });

  it('only the user can decide', () => {
    const a = ask();
    expect(() => brain.approvals.decide(a.id, 'approved', { type: 'agent', id: 'Queen' })).toThrow(/Only the user/);
    clock = 9_000;
    const d = brain.approvals.decide(a.id, 'approved', { type: 'user' });
    expect(d).toMatchObject({ status: 'approved', decidedAt: 9_000 });
    expect(brain.approvals.get(a.id)?.payload).toEqual({ goalId: 'G-1' });
  });

  it('a decision is final', () => {
    const a = ask();
    brain.approvals.decide(a.id, 'denied', { type: 'user' });
    expect(() => brain.approvals.decide(a.id, 'approved', { type: 'user' })).toThrow(/already/);
  });
});
