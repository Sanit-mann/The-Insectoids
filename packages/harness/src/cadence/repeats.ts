import { queryWords } from '@insectoids/brain';
import { MAX_INTERVAL_MINUTES, type ScheduleWhen } from '@insectoids/shared';

/**
 * Spotting a request the user keeps making (Cadence 05-D3; Phase 3 A5), so the Queen can propose a cadence for
 * it. Pure functions: plain word overlap, no model. Times are the computer's local wall-clock time.
 */

const DAY_MS = 24 * 60 * 60_000;
/** Goals asked within this time of the previous one count as one occasion (a retry, not a habit). */
export const RETRY_WINDOW_MS = 60 * 60_000;
/** Only goals from this far back count. */
export const REPEAT_LOOKBACK_MS = 90 * DAY_MS;

/** Words that say when or how politely, not what: dates, weekdays, months, times of day, filler. */
const NOISE = new Set(
  (
    'please thanks thank hey again today tonight tomorrow yesterday now daily weekly monthly every morning afternoon evening night ' +
    'day days week weeks month months year hour hours minute minutes time latest last next new recent recently current ' +
    'monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun ' +
    'january february march april june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec ' +
    'want need like help let can could would get'
  ).split(' '),
);

/** A rough stem, so "summary", "summarise" and "summarize" or "issue" and "issues" meet: drop a plural or -ing/-ed, keep 5 letters. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  return w.slice(0, 5);
}

/** The words of a request that say what is asked: meaningful, not dates, numbers or filler, stemmed. */
export function requestWords(text: string): Set<string> {
  return new Set(
    queryWords(text, { meaningful: true })
      .filter((w) => !NOISE.has(w) && !/^\d+(st|nd|rd|th|am|pm)?$/.test(w))
      .map(stem),
  );
}

/**
 * Two requests are much the same when they share at least two words, those cover most (3/4) of the shorter one,
 * and at least a third of the longer one. "Summarise the open GitHub issues" and "Write a summary of the open
 * issues on GitHub" match; a short request inside a long, detailed one doesn't.
 */
export function sameRequest(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  if (shared < 2) return false;
  return shared / Math.min(a.size, b.size) >= 0.75 && shared / Math.max(a.size, b.size) >= 1 / 3;
}

export interface AskedGoal {
  id: string;
  title: string;
  text: string;
  createdAt: number;
}

export interface RepeatedRequest {
  /** Words at least half of the goals share, sorted: identifies the request. */
  words: string[];
  /** Every matching goal, oldest first (the new one last). */
  goals: AskedGoal[];
  /** The first goal of each occasion (goals within RETRY_WINDOW_MS of the previous one are one occasion). */
  occasions: AskedGoal[];
}

const wordsOf = (g: Pick<AskedGoal, 'title' | 'text'>): Set<string> => requestWords(`${g.title}\n${g.text}`);

/** One goal per occasion: a goal asked within RETRY_WINDOW_MS of the previous counted one is a retry. */
export function occasionsOf<T extends { createdAt: number }>(goals: readonly T[], retryWindowMs = RETRY_WINDOW_MS): T[] {
  const out: T[] = [];
  for (const g of [...goals].sort((a, b) => a.createdAt - b.createdAt)) {
    const last = out.at(-1);
    if (!last || g.createdAt - last.createdAt >= retryWindowMs) out.push(g);
  }
  return out;
}

/**
 * Whether the new goal repeats earlier ones: the earlier goals (user goals of one project; the caller filters)
 * from the last 90 days that are much the same request, plus the new one, on at least `minRepeats` occasions.
 */
export function findRepeatedRequest(goal: AskedGoal, earlier: readonly AskedGoal[], o: { now: number; minRepeats: number; retryWindowMs?: number }): RepeatedRequest | null {
  const mine = wordsOf(goal);
  if (mine.size < 2) return null;
  const since = o.now - REPEAT_LOOKBACK_MS;
  const sets = new Map<string, Set<string>>([[goal.id, mine]]);
  for (const g of earlier) {
    if (g.id === goal.id || g.createdAt < since || g.createdAt > goal.createdAt) continue;
    const w = wordsOf(g);
    if (sameRequest(mine, w)) sets.set(g.id, w);
  }
  const goals = [...earlier.filter((g) => sets.has(g.id) && g.id !== goal.id), goal].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const occasions = occasionsOf(goals, o.retryWindowMs);
  if (occasions.length < o.minRepeats) return null;
  const counts = new Map<string, number>();
  for (const w of sets.values()) for (const x of w) counts.set(x, (counts.get(x) ?? 0) + 1);
  const words = [...counts].filter(([, n]) => n * 2 >= sets.size).map(([w]) => w).sort();
  return { words, goals, occasions };
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const pad = (n: number): string => String(n).padStart(2, '0');

/** The usual local time of day, rounded to the half hour ("09:00", "17:30"). */
export function typicalTime(times: readonly number[]): string {
  const minutes = median(times.map((t) => new Date(t).getHours() * 60 + new Date(t).getMinutes()));
  const m = (Math.round(minutes / 30) * 30) % (24 * 60);
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/**
 * A schedule that fits when the request was made (oldest first): about a day apart → every day at the usual
 * time; about a week apart → weekly on the usual weekday at the usual time; else every N days (at least 1).
 */
export function guessSchedule(times: readonly number[]): ScheduleWhen {
  const sorted = [...times].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((t, i) => t - sorted[i]!);
  const days = gaps.length ? median(gaps) / DAY_MS : 1;
  const time = typicalTime(sorted);
  if (days >= 0.75 && days <= 1.5) return { type: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time };
  if (days >= 5.5 && days <= 8.5) {
    const count = new Map<number, number>();
    for (const t of sorted) count.set(new Date(t).getDay(), (count.get(new Date(t).getDay()) ?? 0) + 1);
    // The most common weekday; on a tie, the latest one asked.
    let best = new Date(sorted.at(-1)!).getDay();
    for (const [d, n] of count) if (n > (count.get(best) ?? 0)) best = d;
    return { type: 'weekly', days: [best], time };
  }
  const n = Math.min(Math.max(1, Math.round(days)), MAX_INTERVAL_MINUTES / (24 * 60));
  return { type: 'interval', everyMinutes: n * 24 * 60 };
}
