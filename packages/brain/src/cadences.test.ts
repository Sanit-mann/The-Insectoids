import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Brain, openBrain } from './index';

/** Cadences and their run log (Cadence 05; Phase 3 A1). */
let brain: Brain;
let clock: number;
let n: number;

const fields = (o: Partial<Parameters<Brain['cadences']['create']>[0]> = {}) => ({
  shelf: 'site',
  name: 'Weekly report',
  when: { type: 'weekly' as const, days: [1], time: '09:00' },
  goal: 'Write the weekly report',
  budgetTokens: 50_000,
  autonomy: 'small-plans' as const,
  enabled: true,
  nextRunAt: 5_000,
  ...o,
});

beforeEach(() => {
  clock = 1_000;
  n = 0;
  brain = openBrain(':memory:', { now: () => clock, newId: () => `id${++n}` });
});
afterEach(() => brain.close());

describe('cadence store', () => {
  it('creates, reads back and lists by shelf in creation order', () => {
    const a = brain.cadences.create(fields());
    clock = 2_000;
    brain.cadences.create(fields({ name: 'Other project', shelf: 'api' }));
    clock = 3_000;
    const c = brain.cadences.create(fields({ name: 'Hourly', when: { type: 'interval', everyMinutes: 60 } }));
    expect(a).toMatchObject({ id: 'CAD-id1', shelf: 'site', name: 'Weekly report', when: { type: 'weekly', days: [1], time: '09:00' }, enabled: true, pending: false, nextRunAt: 5_000, createdAt: 1_000 });
    expect(brain.cadences.list('site').map((x) => x.id)).toEqual([a.id, c.id]);
    expect(brain.cadences.list().length).toBe(3);
    expect(brain.cadences.get('nope')).toBeUndefined();
  });

  it('updates the fields and next run, keeping an owed run', () => {
    const c = brain.cadences.create(fields());
    brain.cadences.setPending(c.id, true);
    clock = 9_000;
    const u = brain.cadences.update(c.id, { name: 'Renamed', when: { type: 'interval', everyMinutes: 30 }, goal: 'New goal', budgetTokens: 10_000, autonomy: 'ask', enabled: true, nextRunAt: 7_000 });
    expect(u).toMatchObject({ name: 'Renamed', when: { type: 'interval', everyMinutes: 30 }, goal: 'New goal', budgetTokens: 10_000, autonomy: 'ask', nextRunAt: 7_000, pending: true, updatedAt: 9_000 });
    expect(() => brain.cadences.update('missing', { ...u })).toThrow(/No cadence/);
  });

  it('switching off clears the next run and any owed run', () => {
    const c = brain.cadences.create(fields());
    brain.cadences.setPending(c.id, true);
    expect(brain.cadences.setEnabled(c.id, false, null)).toMatchObject({ enabled: false, nextRunAt: null, pending: false });
    expect(brain.cadences.setEnabled(c.id, true, 8_000)).toMatchObject({ enabled: true, nextRunAt: 8_000 });
  });

  it('records runs, newest first, and keeps them after the cadence is deleted', () => {
    const c = brain.cadences.create(fields());
    brain.cadences.recordRun({ cadenceId: c.id, reason: 'schedule', outcome: 'started', goalId: 'G-1', message: 'Started.' });
    clock = 2_000;
    brain.cadences.recordRun({ cadenceId: c.id, reason: 'schedule', outcome: 'skipped', message: 'Still going.' });
    brain.cadences.recordRun({ cadenceId: c.id, reason: 'manual', outcome: 'started', goalId: 'G-2', message: 'Run now.' });
    expect(brain.cadences.runs(c.id).map((r) => [r.reason, r.outcome, r.goalId])).toEqual([
      ['manual', 'started', 'G-2'],
      ['schedule', 'skipped', null],
      ['schedule', 'started', 'G-1'],
    ]);
    expect(brain.cadences.runs(c.id, 1)).toHaveLength(1);
    expect(brain.cadences.lastRun(c.id)).toMatchObject({ goalId: 'G-2' });
    brain.cadences.delete(c.id);
    expect(brain.cadences.get(c.id)).toBeUndefined();
    expect(brain.cadences.runs(c.id)).toHaveLength(3);
    expect(() => brain.cadences.delete(c.id)).toThrow(/No cadence/);
  });

  it('lists runs of every cadence after a time, newest first, deleted cadences too, leaving out reasons on request', () => {
    const a = brain.cadences.create(fields());
    const b = brain.cadences.create(fields({ name: 'Other', shelf: 'api' }));
    brain.cadences.recordRun({ cadenceId: a.id, reason: 'schedule', outcome: 'started', goalId: 'G-1', message: 'Old.' });
    clock = 2_000;
    brain.cadences.recordRun({ cadenceId: a.id, reason: 'schedule', outcome: 'skipped', message: 'At the line.' });
    clock = 3_000;
    brain.cadences.recordRun({ cadenceId: b.id, reason: 'webhook', outcome: 'refused', message: 'Bad secret.' });
    brain.cadences.recordRun({ cadenceId: a.id, reason: 'manual', outcome: 'started', goalId: 'G-2', message: 'Run now.' });
    clock = 4_000;
    brain.cadences.recordRun({ cadenceId: a.id, reason: 'catch-up', outcome: 'failed', message: 'No engine.' });
    brain.cadences.delete(b.id);
    // Exclusive of `since`: the run at exactly 2 000 is out.
    expect(brain.cadences.runsSince(2_000).map((r) => r.message)).toEqual(['No engine.', 'Run now.', 'Bad secret.']);
    expect(brain.cadences.runsSince(1_999, { excludeReasons: ['manual'] }).map((r) => r.message)).toEqual(['No engine.', 'Bad secret.', 'At the line.']);
    expect(brain.cadences.runsSince(0, { limit: 2 })).toHaveLength(2);
    expect(brain.cadences.runsSince(4_000)).toEqual([]);
  });

  it('goals remember the cadence that started them', () => {
    const c = brain.cadences.create(fields());
    expect(brain.goals.create({ title: 'g', text: 'g', shelf: 'site', cadenceId: c.id }).cadenceId).toBe(c.id);
    expect(brain.goals.create({ title: 'h', text: 'h', shelf: 'site' }).cadenceId).toBeNull();
  });
});
