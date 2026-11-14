import type { CadenceRunReason } from '@insectoids/brain';
import { type CadenceWhen, scheduleOf } from '@insectoids/shared';

/**
 * When a cadence is due (Cadence 05-D2, D5; Phase 3 A1). Pure functions over epoch milliseconds; weekly times are
 * the computer's local wall-clock time, so daylight saving never shifts them.
 */

export const MINUTE_MS = 60_000;
/** A due run that is later than this counts as a catch-up (the app was closed or the computer slept). */
export const CATCH_UP_AFTER_MS = 2 * MINUTE_MS;

export interface ScheduleOptions {
  /**
   * Milliseconds per "minute" of an interval. 60 000 in real use; the e2e hook (INSECTOIDS_E2E_CADENCE_SECONDS)
   * passes 1 000 so a 15-minute cadence fires after 15 s. Weekly times are never scaled.
   */
  intervalUnitMs?: number;
}

const parseTime = (time: string): { h: number; m: number } => {
  const [h, m] = time.split(':').map(Number);
  return { h: h!, m: m! };
};

/**
 * The instant a local wall-clock time happens on a given local date. A time that doesn't exist that day
 * (spring forward) gives the first valid minute after it, e.g. 02:30 on a day that jumps 02:00 → 03:00 gives 03:00.
 * A time that happens twice (fall back) gives its first occurrence.
 */
export function localInstant(year: number, month: number, day: number, h: number, m: number): number {
  const wanted = h * 60 + m;
  let t = new Date(year, month, day, h, m).getTime();
  const at = new Date(t);
  if (at.getHours() * 60 + at.getMinutes() === wanted) return t;
  // In a gap JS lands past it (by the size of the gap); walk back to the first minute after the jump.
  for (let i = 0; i < 24 * 60; i++) {
    const p = new Date(t - MINUTE_MS);
    const sameDay = p.getFullYear() === year && p.getMonth() === new Date(year, month, day).getMonth() && p.getDate() === new Date(year, month, day).getDate();
    if (!sameDay || p.getHours() * 60 + p.getMinutes() <= wanted) break;
    t = p.getTime();
  }
  return t;
}

/**
 * The first scheduled time strictly after `after`.
 * - interval: `after` + the interval (callers pass the last *scheduled* time, so runs keep their rhythm);
 * - weekly: the next chosen weekday at the local time;
 * - file, event and webhook cadences: null. They have no time; they wait for something to happen (A3, A4), so they never
 *   "miss" a run and never catch up.
 */
export function nextRunAt(when: CadenceWhen, after: number, o: ScheduleOptions = {}): number | null {
  const s = scheduleOf(when);
  return s ? scheduledNext(s, after, o) : null;
}

type Scheduled = Extract<CadenceWhen, { type: 'interval' | 'weekly' }>;

function scheduledNext(when: Scheduled, after: number, o: ScheduleOptions): number {
  if (when.type === 'interval') return after + when.everyMinutes * (o.intervalUnitMs ?? MINUTE_MS);
  const { h, m } = parseTime(when.time);
  const days = new Set(when.days);
  const base = new Date(after);
  for (let d = 0; d <= 8; d++) {
    const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + d);
    if (!days.has(date.getDay())) continue;
    const t = localInstant(date.getFullYear(), date.getMonth(), date.getDate(), h, m);
    if (t > after) return t;
  }
  throw new Error('No weekday chosen.');
}

export interface DueCheck {
  due: boolean;
  /** How many scheduled times have passed (collapsed into one run). 0 when not due. */
  occurrences: number;
  /** The next scheduled time after now: where the cadence goes once this run is handled. */
  nextRunAt: number;
}

/**
 * Is a cadence due at `now`? Any number of missed times collapse into one run ("catch up once", 05-D5); the
 * next time keeps the schedule's own rhythm (an interval stays on its phase; weekly goes to the next slot).
 */
export function dueCheck(whenIn: CadenceWhen, scheduledAt: number, now: number, o: ScheduleOptions = {}): DueCheck {
  // A maintenance job (A5) runs on its inner schedule.
  const when = scheduleOf(whenIn);
  if (!when) throw new Error('File, event and webhook cadences have no schedule.');
  if (scheduledAt > now) return { due: false, occurrences: 0, nextRunAt: scheduledAt };
  if (when.type === 'interval') {
    const step = when.everyMinutes * (o.intervalUnitMs ?? MINUTE_MS);
    const k = Math.floor((now - scheduledAt) / step) + 1;
    return { due: true, occurrences: k, nextRunAt: scheduledAt + k * step };
  }
  let occurrences = 0;
  let t = scheduledAt;
  // Bounded: a year away is at most 7 × 53 slots.
  while (t <= now && occurrences < 400) {
    occurrences++;
    t = scheduledNext(when, t, o);
  }
  if (t <= now) t = scheduledNext(when, now, o);
  return { due: true, occurrences, nextRunAt: t };
}

/** "schedule" when on time; "catch-up" when it is late or several times were collapsed. */
export function runReason(check: DueCheck, scheduledAt: number, now: number): CadenceRunReason {
  return check.occurrences > 1 || now - scheduledAt > CATCH_UP_AFTER_MS ? 'catch-up' : 'schedule';
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
/** Monday first, Sunday last, the way people list a week. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

const andList = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/**
 * The schedule in plain words: "Every 2 hours", "Every Monday and Thursday at 09:00", "Every day at 07:30",
 * "When files change in inbox (*.md)", "After each run of "Weekly report" finishes", "When any goal finishes",
 * "When a goal has used 75% of its budget", "When its webhook is called (runs wait for you, notes are kept)". `nameOf` looks up the cadence a follow-up is chained to (null when it
 * was removed).
 */
export function whenText(when: CadenceWhen, nameOf: (cadenceId: string) => string | null = () => null): string {
  // A maintenance job (A5) reads as its schedule ("Every 6 hours"); its name says which job it is.
  if (when.type === 'maintenance') return whenText(when.schedule, nameOf);
  if (when.type === 'webhook') {
    const trust = when.trust === 'strict' ? 'every call waits for you' : when.trust === 'allow-all' ? 'calls run on their own' : 'runs wait for you, notes are kept';
    return `When its webhook is called (${trust})`;
  }
  if (when.type === 'file') {
    const where = when.folder === '.' ? 'the project' : when.folder;
    return `When files change in ${where}${when.pattern ? ` (${when.pattern})` : ''}`;
  }
  if (when.type === 'event') {
    if (when.on === 'budget-warning') return 'When a goal has used 75% of its budget';
    if (!when.cadenceId) return 'When any goal finishes';
    const name = nameOf(when.cadenceId);
    return name ? `After each run of "${name}" finishes` : 'After each run of a removed cadence finishes';
  }
  if (when.type === 'interval') {
    const min = when.everyMinutes;
    if (min % (7 * 1440) === 0) return min === 7 * 1440 ? 'Every week' : `Every ${plural(min / (7 * 1440), 'week')}`;
    if (min % 1440 === 0) return min === 1440 ? 'Every day' : `Every ${plural(min / 1440, 'day')}`;
    if (min % 60 === 0) return min === 60 ? 'Every hour' : `Every ${plural(min / 60, 'hour')}`;
    return `Every ${plural(min, 'minute')}`;
  }
  const days = new Set(when.days);
  const ordered = WEEK_ORDER.filter((d) => days.has(d));
  if (ordered.length === 7) return `Every day at ${when.time}`;
  if (ordered.length === 5 && ordered.every((d) => d >= 1 && d <= 5)) return `Every weekday at ${when.time}`;
  return `Every ${andList(ordered.map((d) => DAY_NAMES[d]!))} at ${when.time}`;
}
