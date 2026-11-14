import type { CadenceAutonomy, CadenceRunView } from '@insectoids/shared';
import { CheckCircle2, Hourglass, PlayCircle, SkipForward, XCircle, type LucideIcon } from 'lucide-react';

/**
 * Plain words for cadences (Cadence 05; Phase 3 A1). Status is always a word plus an icon, never colour alone.
 */

/** Monday first, as people read a week; values are JavaScript's day numbers (0 = Sunday). */
export const WEEK: ReadonlyArray<{ day: number; short: string; long: string }> = [
  { day: 1, short: 'Mon', long: 'Monday' },
  { day: 2, short: 'Tue', long: 'Tuesday' },
  { day: 3, short: 'Wed', long: 'Wednesday' },
  { day: 4, short: 'Thu', long: 'Thursday' },
  { day: 5, short: 'Fri', long: 'Friday' },
  { day: 6, short: 'Sat', long: 'Saturday' },
  { day: 0, short: 'Sun', long: 'Sunday' },
];

export const AUTONOMY: Record<CadenceAutonomy, { label: string; sentence: string; short: string }> = {
  ask: { label: 'Ask me', sentence: 'You approve every plan before it starts.', short: 'Asks you to approve every plan' },
  'small-plans': {
    label: 'Small plans run',
    sentence: 'One-wave plans start on their own; bigger plans ask you first.',
    short: 'Small plans start on their own',
  },
  run: { label: 'Run on its own', sentence: 'Plans start on their own, whatever their size.', short: 'Plans start on their own' },
};
export const AUTONOMY_ORDER: readonly CadenceAutonomy[] = ['ask', 'small-plans', 'run'];

export const REASON: Record<CadenceRunView['reason'], string> = {
  schedule: 'On schedule',
  'catch-up': 'Catch-up (the app was closed when it was due)',
  wake: 'After waking up (the computer was asleep when it was due)',
  manual: 'Run now',
};

export const OUTCOME: Record<CadenceRunView['outcome'], { label: string; icon: LucideIcon; className: string }> = {
  started: { label: 'Started', icon: PlayCircle, className: 'text-st-done' },
  skipped: { label: 'Skipped', icon: SkipForward, className: 'text-muted' },
  deferred: { label: 'Waiting to run', icon: Hourglass, className: 'text-st-waiting' },
  failed: { label: 'Failed', icon: XCircle, className: 'text-st-blocked' },
};

export const PENDING_ICON = Hourglass;
export const DONE_ICON = CheckCircle2;

const pad = (n: number): string => String(n).padStart(2, '0');
const hhmm = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const sameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "today 09:00", "tomorrow 09:00", "Mon 09:00" (within a week) or "Mon 24 Nov 09:00", always 24-hour. */
export function whenWords(at: number, now: number): string {
  const d = new Date(at);
  const today = new Date(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(today.getDate() + 1);
  if (sameDay(d, today)) return `today ${hhmm(d)}`;
  if (sameDay(d, tomorrow)) return `tomorrow ${hhmm(d)}`;
  const short = WEEK.find((w) => w.day === d.getDay())!.short;
  if (Math.abs(at - now) < 6 * 24 * 3_600_000) return `${short} ${hhmm(d)}`;
  return `${short} ${d.getDate()} ${d.toLocaleString('en', { month: 'short' })} ${hhmm(d)}`;
}

/** "in 5 min", "in 3 hours", "in 2 days". */
export function untilWords(at: number, now: number): string {
  const min = Math.round((at - now) / 60_000);
  if (min < 1) return 'due now';
  if (min < 60) return `in ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.round(hours / 24);
  return `in ${days} days`;
}

/** "next: Mon 09:00, in 2 days", or "Off" when the cadence is switched off. */
export function nextRunWords(nextRunAt: number | null, enabled: boolean, now: number): string {
  if (!enabled || nextRunAt === null) return 'Off';
  return `next: ${whenWords(nextRunAt, now)}, ${untilWords(nextRunAt, now)}`;
}

/** A run's time for the history: "today 09:00" etc. */
export const runTime = (at: number, now: number): string => whenWords(at, now);
