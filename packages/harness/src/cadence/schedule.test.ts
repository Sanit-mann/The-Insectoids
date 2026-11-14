import type { CadenceWhen } from '@insectoids/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATCH_UP_AFTER_MS, MINUTE_MS, type ScheduleOptions, dueCheck, localInstant, nextRunAt as nextOrNull, runReason, whenText } from './schedule';

/**
 * Schedules run on local wall-clock time. These tests pin a daylight-saving zone (New York) for this file only:
 * Vitest runs each file in its own process, and Node picks up a runtime TZ change (checked on Windows too).
 */
const savedTz = process.env['TZ'];
beforeAll(() => {
  process.env['TZ'] = 'America/New_York';
});
afterAll(() => {
  if (savedTz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = savedTz;
});

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const local = (t: number) => {
  const x = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())} ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][x.getDay()]}`;
};

/** Schedules always have a next time. */
const nextRunAt = (w: CadenceWhen, after: number, o?: ScheduleOptions): number => nextOrNull(w, after, o)!;

const weekly = (days: number[], time: string): CadenceWhen => ({ type: 'weekly', days, time });
const every = (everyMinutes: number): CadenceWhen => ({ type: 'interval', everyMinutes });

describe('the test zone is really a daylight-saving zone', () => {
  it('New York is UTC-5 in winter and UTC-4 in summer', () => {
    expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(300);
    expect(new Date(2026, 6, 15).getTimezoneOffset()).toBe(240);
  });
});

describe('interval', () => {
  it('counts from the last scheduled time, in minutes (or the e2e unit)', () => {
    expect(nextRunAt(every(120), 1_000)).toBe(1_000 + 120 * MINUTE_MS);
    expect(nextRunAt(every(15), 1_000, { intervalUnitMs: 1_000 })).toBe(16_000);
  });

  it('keeps real elapsed time across a daylight-saving change (an interval is a duration)', () => {
    const before = at(2026, 3, 8, 1, 0); // 01:00 EST; at 02:00 clocks jump to 03:00
    expect(local(nextRunAt(every(120), before))).toBe('2026-03-08 04:00 Sun');
  });
});

describe('weekly, local time', () => {
  it('finds the next chosen weekday at the time', () => {
    const mon0800 = at(2026, 11, 16, 8, 0); // Monday
    expect(local(nextRunAt(weekly([1, 4], '09:00'), mon0800))).toBe('2026-11-16 09:00 Mon');
    expect(local(nextRunAt(weekly([1, 4], '09:00'), at(2026, 11, 16, 9, 0)))).toBe('2026-11-19 09:00 Thu');
    expect(local(nextRunAt(weekly([1, 4], '09:00'), at(2026, 11, 19, 9, 30)))).toBe('2026-11-23 09:00 Mon');
  });

  it('is strictly after: at exactly the scheduled time it moves to the next slot', () => {
    const t = at(2026, 11, 16, 9, 0);
    expect(nextRunAt(weekly([1], '09:00'), t)).toBe(at(2026, 11, 23, 9, 0));
    expect(nextRunAt(weekly([1], '09:00'), t - 1)).toBe(t);
  });

  it('crosses month and year ends', () => {
    expect(local(nextRunAt(weekly([5], '18:00'), at(2026, 1, 31, 12)))).toBe('2026-02-06 18:00 Fri');
    expect(local(nextRunAt(weekly([0, 1, 2, 3, 4, 5, 6], '07:30'), at(2026, 12, 31, 8)))).toBe('2027-01-01 07:30 Fri');
    expect(local(nextRunAt(weekly([4], '00:00'), at(2028, 2, 28, 23, 59)))).toBe('2028-03-02 00:00 Thu'); // leap year
  });

  it('keeps the wall-clock time across a daylight-saving change', () => {
    // 09:00 every Sunday: the week the clocks spring forward, it is still 09:00 local (one hour less in between).
    const prev = at(2026, 3, 1, 9, 0);
    const next = nextRunAt(weekly([0], '09:00'), prev);
    expect(local(next)).toBe('2026-03-08 09:00 Sun');
    expect(next - prev).toBe(7 * 24 * 3_600_000 - 3_600_000);
    // And in the autumn, one hour more.
    const fallPrev = at(2026, 10, 25, 9, 0);
    expect(nextRunAt(weekly([0], '09:00'), fallPrev) - fallPrev).toBe(7 * 24 * 3_600_000 + 3_600_000);
  });

  it('a time that does not exist (spring forward) runs at the first valid minute after it', () => {
    // 2026-03-08: 02:00 → 03:00 in New York; 02:30 doesn't exist.
    expect(local(localInstant(2026, 2, 8, 2, 30))).toBe('2026-03-08 03:00 Sun');
    expect(local(nextRunAt(weekly([0], '02:30'), at(2026, 3, 7, 12)))).toBe('2026-03-08 03:00 Sun');
    // And the week after, back to 02:30.
    expect(local(nextRunAt(weekly([0], '02:30'), at(2026, 3, 8, 3, 0)))).toBe('2026-03-15 02:30 Sun');
  });

  it('a time that happens twice (fall back) runs once', () => {
    // 2026-11-01: 02:00 EDT → 01:00 EST; 01:30 happens twice.
    const first = nextRunAt(weekly([0], '01:30'), at(2026, 10, 31, 12));
    expect(local(first)).toBe('2026-11-01 01:30 Sun');
    expect(new Date(first).getTimezoneOffset()).toBe(240); // the first one (EDT)
    const after = nextRunAt(weekly([0], '01:30'), first);
    expect(local(after)).toBe('2026-11-08 01:30 Sun'); // not the second 01:30 an hour later
    expect(dueCheck(weekly([0], '01:30'), first, first + 3_600_000)).toMatchObject({ due: true, occurrences: 1 });
  });
});

describe('due check: catch up once', () => {
  it('not due before the time', () => {
    expect(dueCheck(every(60), 10_000, 9_999)).toEqual({ due: false, occurrences: 0, nextRunAt: 10_000 });
  });

  it('due on time: one occurrence, next keeps the rhythm', () => {
    const c = dueCheck(every(60), 10_000, 10_000 + 5_000);
    expect(c).toEqual({ due: true, occurrences: 1, nextRunAt: 10_000 + 60 * MINUTE_MS });
    expect(runReason(c, 10_000, 15_000)).toBe('schedule');
  });

  it('many missed interval runs collapse into one, and the phase is kept', () => {
    const start = at(2026, 11, 14, 9, 0);
    const now = start + 10 * 60 * MINUTE_MS + 7 * MINUTE_MS; // ten and a bit hours later
    const c = dueCheck(every(60), start, now);
    expect(c.occurrences).toBe(11);
    expect(local(c.nextRunAt)).toBe('2026-11-14 20:00 Sat');
    expect(runReason(c, start, now)).toBe('catch-up');
  });

  it('a week away collapses weekly runs into one catch-up', () => {
    const when = weekly([1, 4], '09:00');
    const missed = at(2026, 11, 16, 9, 0);
    const now = at(2026, 11, 27, 12, 0); // two Mondays and two Thursdays have passed
    const c = dueCheck(when, missed, now);
    expect(c.occurrences).toBe(4);
    expect(local(c.nextRunAt)).toBe('2026-11-30 09:00 Mon');
    expect(runReason(c, missed, now)).toBe('catch-up');
  });

  it('one late run is a catch-up once it is more than two minutes late', () => {
    const c = dueCheck(every(60), 0, CATCH_UP_AFTER_MS + 1);
    expect(c.occurrences).toBe(1);
    expect(runReason(c, 0, CATCH_UP_AFTER_MS + 1)).toBe('catch-up');
    expect(runReason(dueCheck(every(60), 0, CATCH_UP_AFTER_MS), 0, CATCH_UP_AFTER_MS)).toBe('schedule');
  });

  it('a year away stays bounded and lands on the next real slot', () => {
    const missed = at(2025, 11, 17, 9, 0);
    const now = at(2026, 11, 18, 10, 0);
    const c = dueCheck(weekly([1], '09:00'), missed, now);
    expect(c.due).toBe(true);
    expect(c.nextRunAt).toBeGreaterThan(now);
    expect(local(c.nextRunAt)).toBe('2026-11-23 09:00 Mon');
  });
});

describe('in plain words', () => {
  it('intervals', () => {
    expect(whenText(every(15))).toBe('Every 15 minutes');
    expect(whenText(every(90))).toBe('Every 90 minutes');
    expect(whenText(every(60))).toBe('Every hour');
    expect(whenText(every(120))).toBe('Every 2 hours');
    expect(whenText(every(1440))).toBe('Every day');
    expect(whenText(every(2 * 1440))).toBe('Every 2 days');
    expect(whenText(every(7 * 1440))).toBe('Every week');
    expect(whenText(every(14 * 1440))).toBe('Every 2 weeks');
  });

  it('weekly, Monday first', () => {
    expect(whenText(weekly([4, 1], '09:00'))).toBe('Every Monday and Thursday at 09:00');
    expect(whenText(weekly([0, 1, 2, 3, 4, 5, 6], '07:30'))).toBe('Every day at 07:30');
    expect(whenText(weekly([1, 2, 3, 4, 5], '08:00'))).toBe('Every weekday at 08:00');
    expect(whenText(weekly([5, 1, 3], '10:15'))).toBe('Every Monday, Wednesday and Friday at 10:15');
    expect(whenText(weekly([0], '18:00'))).toBe('Every Sunday at 18:00');
    expect(whenText(weekly([6, 0], '11:00'))).toBe('Every Saturday and Sunday at 11:00');
  });
});

describe('file and event cadences (A3)', () => {
  const file = (folder: string, pattern: string | null = null): CadenceWhen => ({ type: 'file', folder, pattern });
  const event = (on: 'goal-done' | 'budget-warning', cadenceId: string | null = null): CadenceWhen => ({ type: 'event', on, cadenceId });

  it('have no next time and never catch up', () => {
    expect(nextOrNull(file('inbox'), 1_000)).toBeNull();
    expect(nextOrNull(event('goal-done'), 1_000)).toBeNull();
    expect(nextOrNull({ type: 'webhook', trust: 'communication-only' }, 1_000)).toBeNull();
    expect(() => dueCheck(file('inbox'), 0, 1_000)).toThrow(/no schedule/);
  });

  it('say what they wait for, in plain words', () => {
    expect(whenText(file('inbox', '*.md'))).toBe('When files change in inbox (*.md)');
    expect(whenText(file('docs/incoming'))).toBe('When files change in docs/incoming');
    expect(whenText(file('.'))).toBe('When files change in the project');
    expect(whenText(event('goal-done'))).toBe('When any goal finishes');
    expect(whenText(event('goal-done', 'c1'), (id) => (id === 'c1' ? 'Weekly report' : null))).toBe('After each run of "Weekly report" finishes');
    expect(whenText(event('goal-done', 'gone'), () => null)).toBe('After each run of a removed cadence finishes');
    expect(whenText(event('budget-warning'))).toBe('When a goal has used 75% of its budget');
    expect(whenText({ type: 'webhook', trust: 'communication-only' })).toBe('When its webhook is called (runs wait for you, notes are kept)');
    expect(whenText({ type: 'webhook', trust: 'strict' })).toBe('When its webhook is called (every call waits for you)');
    expect(whenText({ type: 'webhook', trust: 'allow-all' })).toBe('When its webhook is called (calls run on their own)');
  });
});
