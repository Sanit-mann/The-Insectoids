import { describe, expect, it } from 'vitest';
import { type AskedGoal, findRepeatedRequest, guessSchedule, occasionsOf, requestWords, sameRequest, stem, typicalTime } from './repeats';

/** Times are local wall-clock (the functions read local hours and weekdays), so the tests hold in any zone. */
const at = (mo: number, d: number, h = 9, mi = 0) => new Date(2026, mo - 1, d, h, mi).getTime();
const goal = (id: string, text: string, createdAt: number): AskedGoal => ({ id, title: text.slice(0, 60), text, createdAt });

describe('request words', () => {
  it('stems plurals and word forms, and drops dates, numbers and filler', () => {
    expect(stem('issues')).toBe('issue');
    expect(stem('summary')).toBe(stem('summarise'));
    expect(stem('summarize')).toBe(stem('summarised'));
    expect(stem('testing')).toBe(stem('tests'));
    expect([...requestWords("Please summarise today's open GitHub issues for Monday 10 Nov")].sort()).toEqual(['githu', 'issue', 'open', 'summa']);
  });

  it('matches different wording of the same request, not unrelated ones', () => {
    const a = requestWords('Summarise the open GitHub issues and post the summary in notes');
    expect(sameRequest(a, requestWords('Write a summary of the open issues on GitHub'))).toBe(true);
    expect(sameRequest(a, requestWords('Please summarize the open GitHub issues again'))).toBe(true);
    expect(sameRequest(a, requestWords('Fix the login bug on the settings page'))).toBe(false);
    // One shared word is not enough.
    expect(sameRequest(a, requestWords('Close stale GitHub pull requests'))).toBe(false);
  });
});

describe('repeated requests', () => {
  const now = at(11, 12, 10);
  const asked = [
    goal('g1', 'Summarise the open GitHub issues', at(11, 10)),
    goal('x', 'Fix the login bug on the settings page', at(11, 10, 11)),
    goal('g2', 'Write a summary of the open issues on GitHub', at(11, 11)),
  ];

  it('needs three occasions including the new one', () => {
    const g3 = goal('g3', 'Please summarize the open GitHub issues', at(11, 12));
    const r = findRepeatedRequest(g3, asked, { now, minRepeats: 3 });
    expect(r?.goals.map((g) => g.id)).toEqual(['g1', 'g2', 'g3']);
    expect(r?.words).toEqual(['githu', 'issue', 'open', 'summa']);
    expect(findRepeatedRequest(g3, asked.slice(0, 2), { now, minRepeats: 3 })).toBeNull();
  });

  it('counts goals within an hour of each other as one occasion', () => {
    const quick = [goal('a', 'Summarise the open GitHub issues', at(11, 12, 9)), goal('b', 'Summarise the open GitHub issues', at(11, 12, 9, 20))];
    const c = goal('c', 'Summarise the open GitHub issues', at(11, 12, 9, 40));
    expect(occasionsOf([...quick, c]).map((g) => g.id)).toEqual(['a']);
    expect(findRepeatedRequest(c, quick, { now, minRepeats: 3 })).toBeNull();
  });

  it('ignores goals older than 90 days', () => {
    const old = [goal('o1', 'Summarise the open GitHub issues', at(5, 1)), goal('o2', 'Summarise the open GitHub issues', at(5, 2))];
    expect(findRepeatedRequest(goal('n', 'Summarise the open GitHub issues', at(11, 12)), old, { now, minRepeats: 3 })).toBeNull();
  });
});

describe('schedule guess', () => {
  it('about a day apart: every day at the usual time, rounded to the half hour', () => {
    expect(guessSchedule([at(11, 10, 9, 5), at(11, 11, 9, 20), at(11, 12, 8, 50)])).toEqual({ type: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' });
    expect(typicalTime([at(11, 10, 17, 20), at(11, 11, 17, 25)])).toBe('17:30');
  });

  it('about a week apart: weekly on that weekday', () => {
    const mondays = [at(10, 26, 10), at(11, 2, 10, 10), at(11, 9, 9, 55)];
    expect(guessSchedule(mondays)).toEqual({ type: 'weekly', days: [new Date(mondays[0]!).getDay()], time: '10:00' });
  });

  it('otherwise every N days, at least one', () => {
    expect(guessSchedule([at(11, 1), at(11, 4), at(11, 7)])).toEqual({ type: 'interval', everyMinutes: 3 * 24 * 60 });
    expect(guessSchedule([at(11, 12, 9), at(11, 12, 11), at(11, 12, 13)])).toEqual({ type: 'interval', everyMinutes: 24 * 60 });
  });
});
