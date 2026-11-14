import type { CadenceAutonomy, CadenceRunView, CadenceWhen, HiveEventTrigger, WebhookTrust } from '@insectoids/shared';
import { Ban, CheckCircle2, Hourglass, NotebookPen, PlayCircle, ShieldX, SkipForward, XCircle, type LucideIcon } from 'lucide-react';

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
  file: 'Files changed',
  event: 'Hive event',
  webhook: 'Webhook call',
};

/** How much a webhook's sender is trusted (A4, Cadence 05-D4), as choices with one plain sentence each. */
export const TRUST: Record<WebhookTrust, { label: string; sentence: string }> = {
  strict: { label: 'Strict', sentence: 'Every call waits for you, notes too.' },
  'communication-only': {
    label: 'Notes in, runs wait',
    sentence: 'Notes go into the Brain; anything that asks the hive to act waits for you.',
  },
  'allow-all': { label: 'Allow all', sentence: 'Notes are kept and runs start on their own. Only for senders you trust.' },
};
export const TRUST_ORDER: readonly WebhookTrust[] = ['strict', 'communication-only', 'allow-all'];

/** The two hive events a cadence can wait for (A3), as choices and as "waits for" words. */
export const HIVE_EVENTS: Record<HiveEventTrigger, { label: string; waits: string }> = {
  'goal-done': { label: 'A goal finishes', waits: 'Waits for a goal to finish' },
  'budget-warning': { label: 'A goal has used 75% of its budget', waits: 'Waits for a goal to use 75% of its budget' },
};
export const HIVE_EVENT_ORDER: readonly HiveEventTrigger[] = ['goal-done', 'budget-warning'];

export const OUTCOME: Record<CadenceRunView['outcome'], { label: string; icon: LucideIcon; className: string }> = {
  started: { label: 'Started', icon: PlayCircle, className: 'text-st-done' },
  skipped: { label: 'Skipped', icon: SkipForward, className: 'text-muted' },
  deferred: { label: 'Waiting to run', icon: Hourglass, className: 'text-st-waiting' },
  failed: { label: 'Failed', icon: XCircle, className: 'text-st-blocked' },
  waiting: { label: 'Waiting for you', icon: Hourglass, className: 'text-st-waiting' },
  noted: { label: 'Note saved', icon: NotebookPen, className: 'text-st-done' },
  refused: { label: 'Refused', icon: ShieldX, className: 'text-st-blocked' },
  declined: { label: 'You said no', icon: Ban, className: 'text-muted' },
  /** A built-in maintenance job ran (A5); its message says what it did. */
  done: { label: 'Done', icon: CheckCircle2, className: 'text-st-done' },
};

/** The note under Housekeeping (A5, Cadence 05-D7). */
export const HOUSEKEEPING_NOTE = "Built-in jobs run without AI and cost no tokens. You can switch them off; they can't be removed.";

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

/** "Waits for files in inbox" / "Waits for a goal to finish" / "Waits for its webhook to be called": what a file, event (A3) or webhook (A4) cadence waits for. */
export function waitsWords(when: CadenceWhen): string | null {
  if (when.type === 'file') {
    const where = when.folder === '.' ? 'the project' : when.folder;
    return `Waits for files in ${where}${when.pattern ? ` (${when.pattern})` : ''}`;
  }
  if (when.type === 'event') return HIVE_EVENTS[when.on].waits;
  if (when.type === 'webhook') return 'Waits for its webhook to be called';
  return null;
}

/**
 * "next: Mon 09:00, in 2 days" for schedules, "Waits for files in inbox" for file and event cadences, or "Off"
 * when the cadence is switched off.
 */
export function nextRunWords(when: CadenceWhen, nextRunAt: number | null, enabled: boolean, now: number): string {
  if (!enabled) return 'Off';
  const waits = waitsWords(when);
  if (waits) return waits;
  if (nextRunAt === null) return 'Off';
  return `next: ${whenWords(nextRunAt, now)}, ${untilWords(nextRunAt, now)}`;
}

/** A run's time for the history: "today 09:00" etc. */
export const runTime = (at: number, now: number): string => whenWords(at, now);
