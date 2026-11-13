import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Brain, openBrain } from './brain';
import type { NewCard } from './taskboard';

let brain: Brain;
let clock: number;

const card = (over: Partial<NewCard> = {}): NewCard => ({
  id: 'G-1.C-01',
  goalId: 'G-1',
  wave: 1,
  title: 'Build the pricing page',
  brief: 'Three plans.',
  caste: 'coder',
  priority: 'normal',
  acceptance: ['Tests pass'],
  dependsOn: [],
  ...over,
});

beforeEach(() => {
  clock = 1_000_000;
  brain = openBrain(':memory:', { now: () => clock });
});
afterEach(() => brain.close());

describe('held cards (C2)', () => {
  it('a held card cannot be claimed until the hold ends', () => {
    const board = brain.taskboard;
    board.post(card());
    const held = board.hold('G-1.C-01', 'Watchdog', 'Ran the same command 10 times');
    expect(held.heldReason).toBe('Ran the same command 10 times');
    expect(board.claimNext({ agentId: 'Ant-01', caste: 'coder', leaseMs: 1000 })).toBeNull();
    board.unhold('G-1.C-01', 'Foreman');
    expect(board.claimNext({ agentId: 'Ant-01', caste: 'coder', leaseMs: 1000 })?.id).toBe('G-1.C-01');
  });

  it('only open cards can be held', () => {
    const board = brain.taskboard;
    board.post(card());
    board.claimNext({ agentId: 'Ant-01', caste: 'coder', leaseMs: 1000 });
    expect(() => board.hold('G-1.C-01', 'Watchdog', 'x')).toThrow(/open/);
  });
});

describe('Foreman retry (C2)', () => {
  const failOut = (): void => {
    const board = brain.taskboard;
    board.post(card({ maxAttempts: 1 }));
    board.claimNext({ agentId: 'Ant-01', caste: 'coder', leaseMs: 1000 });
    board.giveUp('G-1.C-01', 'Ant-01', 'crash');
  };

  it('gives a failed card exactly one more attempt, with a note and a tier', () => {
    failOut();
    const board = brain.taskboard;
    expect(board.get('G-1.C-01')!.status).toBe('failed');
    const c = board.foremanRetry('G-1.C-01', 'Foreman', { note: 'Read the error first.', tier: 'strongest' });
    expect(c.status).toBe('open');
    expect(c.escalated).toBe(false);
    expect(c.maxAttempts).toBe(2);
    expect(c.foremanRetries).toBe(1);
    expect(c.foremanNote).toBe('Read the error first.');
    expect(c.foremanTier).toBe('strongest');
    expect(() => board.foremanRetry('G-1.C-01', 'Foreman', { note: null, tier: null })).toThrow(/already/);
  });

  it('releases a held card without adding attempts', () => {
    const board = brain.taskboard;
    board.post(card());
    board.hold('G-1.C-01', 'Watchdog', 'stalled');
    const c = board.foremanRetry('G-1.C-01', 'Foreman', { note: 'Smaller steps.', tier: null });
    expect(c.heldReason).toBeNull();
    expect(c.maxAttempts).toBe(3);
    expect(c.status).toBe('open');
  });

  it('escalates a held card to the Queen: failed, escalated, hold cleared', () => {
    const board = brain.taskboard;
    board.post(card());
    board.hold('G-1.C-01', 'Watchdog', 'stalled');
    const c = board.escalate('G-1.C-01', 'Foreman', 'The card is too big.');
    expect(c.status).toBe('failed');
    expect(c.escalated).toBe(true);
    expect(c.heldReason).toBeNull();
    expect(board.escalated()).toEqual(['G-1.C-01']);
  });

  it('counts lease expiries', () => {
    const board = brain.taskboard;
    board.post(card());
    board.claimNext({ agentId: 'Ant-01', caste: 'coder', leaseMs: 1000 });
    clock += 5_000;
    board.sweepExpiredLeases();
    board.claimNext({ agentId: 'Ant-02', caste: 'coder', leaseMs: 1000 });
    clock += 5_000;
    board.sweepExpiredLeases();
    expect(board.leaseExpiries('G-1.C-01')).toBe(2);
  });
});

describe('incidents and Foreman decisions (C2)', () => {
  it('counts recurrence per signature, newest first', () => {
    const a = brain.incidents.record({ sensor: 'loop', step: 'warn', agentId: 'Ant-01', cardId: 'G-1.C-01', evidence: 'Ran npm test 5 times', signature: 'loop|coder|npm test' });
    clock += 1;
    const b = brain.incidents.record({ sensor: 'loop', step: 'pause-card', agentId: 'Ant-02', cardId: 'G-1.C-01', evidence: 'Ran npm test 10 times', signature: 'loop|coder|npm test' });
    clock += 1;
    brain.incidents.record({ sensor: 'stall', step: 'warn', agentId: 'Ant-03', evidence: 'No progress for 5 minutes', signature: 'stall|tester|' });
    expect(a.recurrence).toBe(0);
    expect(b.recurrence).toBe(1);
    const list = brain.incidents.list();
    expect(list.map((i) => i.agentId)).toEqual(['Ant-03', 'Ant-02', 'Ant-01']);
    expect(brain.incidents.list({ cardId: 'G-1.C-01' })).toHaveLength(2);
    expect(brain.incidents.list({ since: clock })).toHaveLength(1);
  });

  it('keeps the Foreman decisions, newest first', () => {
    brain.foreman.record({ goalId: 'G-1', cardId: 'G-1.C-01', cardTitle: 'A', wake: 'held', action: 'retry-with-note', reason: 'It looped.' });
    clock += 1;
    brain.foreman.record({ goalId: 'G-1', cardId: 'G-1.C-02', cardTitle: 'B', wake: 'attempts-exhausted', action: 'to-queen', reason: 'Unclear card.' });
    expect(brain.foreman.list().map((d) => d.cardId)).toEqual(['G-1.C-02', 'G-1.C-01']);
    expect(brain.foreman.forCard('G-1.C-01')[0]!.action).toBe('retry-with-note');
  });
});
