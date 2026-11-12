import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Brain } from './brain';
import { openBrain } from './brain';
import type { NewCard, Taskboard } from './taskboard';

let brain: Brain;
let board: Taskboard;
let clock: number;
const MIN = 60_000;

const card = (over: Partial<NewCard> = {}): NewCard => ({
  id: 'C-01',
  goalId: 'G-1',
  wave: 1,
  title: 'Build the pricing page',
  brief: 'Three plans and a yearly toggle.',
  caste: 'coder',
  priority: 'normal',
  acceptance: ['Tests pass'],
  dependsOn: [],
  ...over,
});

beforeEach(() => {
  clock = 1_000_000;
  brain = openBrain(':memory:', { now: () => clock });
  board = brain.taskboard;
});
afterEach(() => brain.close());

describe('posting cards', () => {
  it('posts a valid card as open', () => {
    board.post(card());
    expect(board.get('C-01')).toMatchObject({ status: 'open', attempts: 0, caste: 'coder' });
  });

  it('refuses a card without "done means" criteria', () => {
    expect(() => board.post(card({ acceptance: [] }))).toThrow();
  });

  it('refuses a duplicate card id', () => {
    board.post(card());
    expect(() => board.post(card())).toThrow();
  });
});

describe('claiming (Hive 02-D10)', () => {
  it('an insect of the right caste claims an open card with a lease', () => {
    board.post(card());
    const claimed = board.claim('C-01', { agentId: 'Ant-07', caste: 'coder', leaseMs: 20 * MIN });
    expect(claimed).toMatchObject({ status: 'claimed', claimedBy: 'Ant-07', leaseExpiresAt: clock + 20 * MIN });
  });

  it('an insect of another caste cannot claim it', () => {
    board.post(card());
    expect(board.claim('C-01', { agentId: 'Ant-02', caste: 'tester', leaseMs: MIN })).toBeNull();
  });

  it('a card already claimed cannot be claimed again', () => {
    board.post(card());
    board.claim('C-01', { agentId: 'Ant-07', caste: 'coder', leaseMs: MIN });
    expect(board.claim('C-01', { agentId: 'Ant-08', caste: 'coder', leaseMs: MIN })).toBeNull();
    expect(board.get('C-01')?.claimedBy).toBe('Ant-07');
  });

  it('a card stays locked until its dependencies are done', () => {
    board.post(card({ id: 'C-01' }));
    board.post(card({ id: 'C-02', caste: 'tester', dependsOn: ['C-01'] }));
    expect(board.claim('C-02', { agentId: 'Ant-02', caste: 'tester', leaseMs: MIN })).toBeNull();

    board.claim('C-01', { agentId: 'Ant-07', caste: 'coder', leaseMs: MIN });
    board.start('C-01', 'Ant-07');
    board.submit('C-01', 'Ant-07', 'Page built');
    board.review('C-01', { verdict: 'pass', by: 'Inspector' });

    expect(board.claim('C-02', { agentId: 'Ant-02', caste: 'tester', leaseMs: MIN })).not.toBeNull();
  });

  it('claimNext takes the most urgent card for the caste, oldest first', () => {
    board.post(card({ id: 'C-low', priority: 'low' }));
    clock += 1;
    board.post(card({ id: 'C-high-old', priority: 'high' }));
    clock += 1;
    board.post(card({ id: 'C-high-new', priority: 'high' }));
    board.post(card({ id: 'C-test', priority: 'critical', caste: 'tester' }));
    expect(board.claimNext({ agentId: 'Ant-07', caste: 'coder', leaseMs: MIN })?.id).toBe('C-high-old');
    expect(board.claimNext({ agentId: 'Ant-08', caste: 'coder', leaseMs: MIN })?.id).toBe('C-high-new');
    expect(board.claimNext({ agentId: 'Ant-09', caste: 'coder', leaseMs: MIN })?.id).toBe('C-low');
    expect(board.claimNext({ agentId: 'Ant-10', caste: 'coder', leaseMs: MIN })).toBeNull();
  });
});

describe('leases: a crashed insect never strands a card', () => {
  beforeEach(() => {
    board.post(card());
    board.claim('C-01', { agentId: 'Ant-07', caste: 'coder', leaseMs: 10 * MIN });
    board.start('C-01', 'Ant-07');
  });

  it('the holder can renew its lease; others cannot', () => {
    clock += 5 * MIN;
    expect(board.heartbeat('C-01', 'Ant-07', 10 * MIN)).toBe(true);
    expect(board.get('C-01')?.leaseExpiresAt).toBe(clock + 10 * MIN);
    expect(board.heartbeat('C-01', 'Ant-99', 10 * MIN)).toBe(false);
  });

  it('an expired lease returns the card to the board and counts an attempt', () => {
    clock += 11 * MIN;
    expect(board.sweepExpiredLeases()).toEqual(['C-01']);
    expect(board.get('C-01')).toMatchObject({ status: 'open', attempts: 1 });
    expect(board.get('C-01')?.claimedBy).toBeUndefined();
    expect(board.events('C-01').at(-1)).toMatchObject({ actor: 'foreman', note: 'lease expired' });
  });

  it('a live lease is left alone', () => {
    clock += 9 * MIN;
    expect(board.sweepExpiredLeases()).toEqual([]);
    expect(board.get('C-01')?.status).toBe('in_progress');
  });
});

describe('lifecycle, review, retry and escalation', () => {
  const run = (agent = 'Ant-07') => {
    board.claim('C-01', { agentId: agent, caste: 'coder', leaseMs: MIN });
    board.start('C-01', agent);
    board.submit('C-01', agent, 'Done, tests pass');
  };

  beforeEach(() => board.post(card({ maxAttempts: 2 })));

  it('passing review is the only way to done', () => {
    run();
    expect(board.get('C-01')?.status).toBe('review');
    board.review('C-01', { verdict: 'pass', by: 'Inspector' });
    expect(board.get('C-01')).toMatchObject({ status: 'done', result: 'Done, tests pass' });
  });

  it('a failed review sends the card back as a retry', () => {
    run();
    board.review('C-01', { verdict: 'fail', by: 'Inspector', note: 'FAQ missing' });
    expect(board.get('C-01')).toMatchObject({ status: 'open', attempts: 1 });
    expect(board.get('C-01')?.claimedBy).toBeUndefined();
  });

  it('after the last allowed attempt the card fails and is escalated', () => {
    run('Ant-07');
    board.review('C-01', { verdict: 'fail', by: 'Inspector' });
    run('Ant-08');
    board.review('C-01', { verdict: 'fail', by: 'Inspector' });
    expect(board.get('C-01')).toMatchObject({ status: 'failed', attempts: 2, escalated: true });
    expect(board.escalated()).toEqual(['C-01']);
  });

  it('a blocked card can resume', () => {
    board.claim('C-01', { agentId: 'Ant-07', caste: 'coder', leaseMs: MIN });
    board.start('C-01', 'Ant-07');
    board.block('C-01', 'Ant-07', 'Needs approval: new dependency');
    expect(board.get('C-01')?.status).toBe('blocked');
    board.unblock('C-01', 'Ant-07');
    expect(board.get('C-01')?.status).toBe('in_progress');
  });

  it('refuses illegal moves', () => {
    expect(() => board.submit('C-01', 'Ant-07', 'x')).toThrow(/open -> review/);
    expect(() => board.review('C-01', { verdict: 'pass', by: 'Inspector' })).toThrow();
  });

  it('only the holder can move its card', () => {
    board.claim('C-01', { agentId: 'Ant-07', caste: 'coder', leaseMs: MIN });
    expect(() => board.start('C-01', 'Ant-99')).toThrow(/held by Ant-07/);
  });

  it('keeps an event history of every move', () => {
    run();
    board.review('C-01', { verdict: 'pass', by: 'Inspector' });
    expect(board.events('C-01').map((e) => `${e.from}->${e.to} by ${e.actor}`)).toEqual([
      'none->open by queen',
      'open->claimed by Ant-07',
      'claimed->in_progress by Ant-07',
      'in_progress->review by Ant-07',
      'review->done by Inspector',
    ]);
  });
});
