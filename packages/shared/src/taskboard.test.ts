import { describe, expect, it } from 'vitest';
import { canTransition, isClaimable, transition, type TaskCard, TaskCardSchema } from './taskboard';

const card = (over: Partial<TaskCard> = {}): TaskCard =>
  TaskCardSchema.parse({
    id: 'C-01',
    goalId: 'G-1',
    wave: 1,
    title: 'Build the pricing page',
    brief: 'Three plans and a yearly toggle.',
    caste: 'coder',
    priority: 'high',
    acceptance: ['Tests pass'],
    dependsOn: [],
    status: 'open',
    attempts: 0,
    ...over,
  });

describe('task card schema', () => {
  it('accepts a valid card and applies defaults', () => {
    const c = card();
    expect(c.status).toBe('open');
    expect(c.claimedBy).toBeUndefined();
  });

  it('rejects a card without acceptance criteria', () => {
    expect(() => card({ acceptance: [] })).toThrow();
  });

  it('rejects an unknown caste', () => {
    expect(() => TaskCardSchema.parse({ ...card(), caste: 'wizard' })).toThrow();
  });
});

describe('status transitions (Hive D10)', () => {
  it.each([
    ['open', 'claimed'],
    ['claimed', 'in_progress'],
    ['claimed', 'open'],
    ['claimed', 'failed'],
    ['in_progress', 'blocked'],
    ['in_progress', 'review'],
    ['in_progress', 'open'],
    ['blocked', 'in_progress'],
    ['review', 'done'],
    ['review', 'open'],
    ['in_progress', 'failed'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    ['open', 'done'],
    ['open', 'in_progress'],
    ['claimed', 'done'],
    ['done', 'open'],
    ['failed', 'in_progress'],
    ['blocked', 'done'],
  ] as const)('forbids %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('only the Inspector path reaches done: review is required', () => {
    expect(canTransition('in_progress', 'done')).toBe(false);
  });

  it('transition returns a new card and leaves the original untouched', () => {
    const c = card();
    const next = transition(c, 'claimed');
    expect(next.status).toBe('claimed');
    expect(c.status).toBe('open');
  });

  it('transition throws on an illegal move', () => {
    expect(() => transition(card(), 'done')).toThrow(/open -> done/);
  });

  it('returning to open after review counts as a new attempt', () => {
    const inReview = card({ status: 'review', attempts: 1 });
    expect(transition(inReview, 'open').attempts).toBe(2);
  });
});

describe('claimability', () => {
  it('an open card with no dependencies is claimable', () => {
    expect(isClaimable(card(), new Set())).toBe(true);
  });

  it('a card stays locked until every dependency is done', () => {
    const c = card({ dependsOn: ['C-02', 'C-03'] });
    expect(isClaimable(c, new Set(['C-02']))).toBe(false);
    expect(isClaimable(c, new Set(['C-02', 'C-03']))).toBe(true);
  });

  it('a card that is not open is never claimable', () => {
    expect(isClaimable(card({ status: 'claimed' }), new Set())).toBe(false);
  });
});
