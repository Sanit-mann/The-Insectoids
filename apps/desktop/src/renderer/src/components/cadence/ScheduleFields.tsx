import { MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES, type ScheduleWhen } from '@insectoids/shared';
import { type KeyboardEvent, useId } from 'react';
import { cn } from '@/lib/utils';
import { WEEK } from './cadence-words';

/**
 * The schedule controls (interval or weekly), shared by the cadence form and the Housekeeping schedule editor
 * (Phase 3 A1, A5). The caller keeps the draft; `checkSchedule` turns it into a `ScheduleWhen` or problems in words.
 */

export const inputCls = 'min-h-10 rounded-[10px] border border-line bg-ground px-3 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-honey';

export type Unit = 'minutes' | 'hours';

export interface ScheduleDraft {
  every: string;
  unit: Unit;
  days: number[];
  time: string;
}

export const DEFAULT_SCHEDULE_DRAFT: ScheduleDraft = { every: '1', unit: 'hours', days: [1], time: '09:00' };

/** A draft from a saved schedule. */
export function scheduleDraftOf(s: ScheduleWhen): ScheduleDraft {
  if (s.type === 'interval') {
    const hours = s.everyMinutes % 60 === 0;
    return { ...DEFAULT_SCHEDULE_DRAFT, every: String(hours ? s.everyMinutes / 60 : s.everyMinutes), unit: hours ? 'hours' : 'minutes' };
  }
  return { ...DEFAULT_SCHEDULE_DRAFT, days: [...s.days], time: s.time };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Everything wrong with the schedule, in words, or the schedule itself. */
export function checkSchedule(kind: ScheduleWhen['type'], d: ScheduleDraft): { problems: string[]; when: ScheduleWhen | null } {
  const problems: string[] = [];
  if (kind === 'interval') {
    const n = Number(d.every);
    const minutes = d.unit === 'hours' ? n * 60 : n;
    if (!Number.isInteger(n) || n < 1) problems.push('How often: use a whole number, like 2.');
    else if (minutes < MIN_INTERVAL_MINUTES) problems.push(`How often: the shortest interval is ${MIN_INTERVAL_MINUTES} minutes.`);
    else if (minutes > MAX_INTERVAL_MINUTES) problems.push('How often: the longest interval is 4 weeks.');
    else return { problems, when: { type: 'interval', everyMinutes: minutes } };
    return { problems, when: null };
  }
  if (!d.days.length) problems.push('Pick at least one day.');
  if (!TIME.test(d.time)) problems.push('Pick a time, like 09:00.');
  if (problems.length) return { problems, when: null };
  return { problems, when: { type: 'weekly', days: [...d.days].sort((a, b) => a - b), time: d.time } };
}

/** The two schedule kinds as radio choices (labels shared with the cadence form). */
export const SCHEDULE_KINDS: ReadonlyArray<{ kind: ScheduleWhen['type']; label: string }> = [
  { kind: 'interval', label: 'Every few minutes or hours' },
  { kind: 'weekly', label: 'On days of the week' },
];

/** A radio group to pick interval or weekly (roving tab stop, arrow keys move and select). */
export function ScheduleKindPicker({ kind, onChange }: { kind: ScheduleWhen['type']; onChange: (k: ScheduleWhen['type']) => void }) {
  const uid = useId();
  const onKey = (ev: KeyboardEvent<HTMLButtonElement>) => {
    const step = ev.key === 'ArrowDown' || ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowUp' || ev.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    ev.preventDefault();
    const i = SCHEDULE_KINDS.findIndex((k) => k.kind === kind);
    const next = SCHEDULE_KINDS[(i + step + SCHEDULE_KINDS.length) % SCHEDULE_KINDS.length]!.kind;
    onChange(next);
    document.getElementById(`${uid}-kind-${next}`)?.focus();
  };
  return (
    <div aria-label="Kind of schedule" className="flex flex-wrap gap-2" role="radiogroup">
      {SCHEDULE_KINDS.map(({ kind: k, label }) => (
        <button
          aria-checked={kind === k}
          className={cn(
            'inline-flex min-h-10 items-center rounded-full border px-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-honey',
            kind === k ? 'border-honey text-honey-text' : 'border-line bg-ground text-text hover:bg-surface-2',
          )}
          id={`${uid}-kind-${k}`}
          key={k}
          onClick={() => onChange(k)}
          onKeyDown={onKey}
          role="radio"
          tabIndex={kind === k ? 0 : -1}
          type="button"
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** "Every [n] [unit]" or the weekday buttons plus a local time, depending on `kind`. */
export function ScheduleFields({
  kind,
  draft,
  onChange,
}: {
  kind: ScheduleWhen['type'];
  draft: ScheduleDraft;
  onChange: (patch: Partial<ScheduleDraft>) => void;
}) {
  if (kind === 'interval') {
    return (
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Every</span>
          <input
            className={cn(inputCls, 'w-24')}
            inputMode="numeric"
            min={1}
            onChange={(e) => onChange({ every: e.target.value })}
            type="number"
            value={draft.every}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Unit</span>
          <select className={inputCls} onChange={(e) => onChange({ unit: e.target.value as Unit })} value={draft.unit}>
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
          </select>
        </label>
        <p className="m-0 pb-2 text-xs text-muted">At least every {MIN_INTERVAL_MINUTES} minutes, at most every 4 weeks.</p>
      </div>
    );
  }
  const toggleDay = (day: number) => onChange({ days: draft.days.includes(day) ? draft.days.filter((x) => x !== day) : [...draft.days, day] });
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div aria-label="Days" className="flex flex-wrap gap-1.5" role="group">
        {WEEK.map((w) => (
          <button
            aria-pressed={draft.days.includes(w.day)}
            className={cn(
              'inline-flex min-h-10 min-w-12 items-center justify-center rounded-[10px] border px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-honey',
              draft.days.includes(w.day) ? 'border-honey bg-honey/10 font-semibold text-honey-text' : 'border-line bg-ground text-text hover:bg-surface-2',
            )}
            key={w.day}
            onClick={() => toggleDay(w.day)}
            type="button"
          >
            {/* Name "Monday", shown "Mon": the shown text starts the name (label in name, WCAG 2.5.3). */}
            <span aria-hidden="true">{w.short}</span>
            <span className="sr-only">{w.long}</span>
          </button>
        ))}
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Time (your local time)</span>
        <input className={cn(inputCls, 'w-32 font-mono')} onChange={(e) => onChange({ time: e.target.value })} step={60} type="time" value={draft.time} />
      </label>
    </div>
  );
}
