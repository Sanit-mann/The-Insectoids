import { type CadenceView, MAINTENANCE_JOBS, MAINTENANCE_JOB_ORDER, type MaintenanceJob, type ScheduleWhen, scheduleOf } from '@insectoids/shared';
import { CalendarClock, History, Info, Play, Wrench } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { Switch } from '@/components/connections/Switch';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { runCommand } from '@/lib/hive-store';
import { cn } from '@/lib/utils';
import { HOUSEKEEPING_NOTE, OUTCOME, PENDING_ICON, nextRunWords, runTime } from './cadence-words';
import { ScheduleFields, ScheduleKindPicker, checkSchedule, scheduleDraftOf } from './ScheduleFields';

/**
 * Housekeeping (Cadence 05-D7; Phase 3 A5): the hive's built-in maintenance jobs. They live on the Global shelf,
 * so they show (and run) whichever project is open, or none. The user can switch them on or off, run them now,
 * see their runs and change their schedule; they can't be renamed or removed.
 */

/** The job a built-in cadence runs, or null for the user's own cadences. */
export const jobOf = (c: CadenceView): MaintenanceJob | null => (c.when.type === 'maintenance' ? c.when.job : null);
/** Built-in maintenance jobs (A5); never shown in the user's own list. */
export const isBuiltIn = (c: CadenceView): boolean => c.builtIn || c.when.type === 'maintenance';

function HousekeepingRow({
  c,
  job,
  now,
  selected,
  editing,
  onHistory,
  onSchedule,
  onError,
}: {
  c: CadenceView;
  job: MaintenanceJob;
  now: number;
  selected: boolean;
  editing: boolean;
  onHistory: () => void;
  onSchedule: () => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const act = async (cmd: Parameters<typeof runCommand>[0]) => {
    setBusy(true);
    const r = await runCommand(cmd);
    setBusy(false);
    if (!r.ok) onError(r.error);
  };
  const last = c.lastRun ? OUTCOME[c.lastRun.outcome] : null;
  const LastIcon = last?.icon;

  return (
    <li
      aria-label={c.name}
      className={cn('flex flex-col gap-3 rounded-2xl border bg-surface p-4', selected || editing ? 'border-honey' : 'border-line')}
      data-cadence-id={c.id}
      data-job={job}
      data-testid="housekeeping-row"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="m-0 truncate font-display text-[15px] font-semibold">{c.name}</h3>
          <p className="m-0 text-sm text-muted" data-testid="housekeeping-sentence">
            {MAINTENANCE_JOBS[job].sentence}
          </p>
          <p className="m-0 text-sm text-text" data-testid="housekeeping-when">
            {c.whenText}
          </p>
          <p className="m-0 font-mono text-xs text-muted" data-testid="housekeeping-next">
            {nextRunWords(c.when, c.nextRunAt, c.enabled, now)}
          </p>
        </div>
        <Switch
          checked={c.enabled}
          disabled={busy}
          label={`Run "${c.name}" on its schedule`}
          onChange={(on) => void act({ type: 'setCadenceEnabled', id: c.id, enabled: on })}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {c.pending ? (
          <span className="inline-flex items-center gap-1.5 font-medium text-st-waiting" data-testid="housekeeping-pending">
            <PENDING_ICON aria-hidden="true" className="size-3.5" />
            Waiting to run
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1.5" data-testid="housekeeping-last-run">
          {last && LastIcon && c.lastRun ? (
            <>
              <LastIcon aria-hidden="true" className={cn('size-3.5', last.className)} />
              <span>
                Last run: <span className={cn('font-medium', last.className)}>{last.label}</span>, {runTime(c.lastRun.at, now)}
              </span>
            </>
          ) : (
            'Not run yet'
          )}
        </span>
      </div>
      {c.lastRun?.message ? <p className="m-0 text-xs text-muted">{c.lastRun.message}</p> : null}

      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void act({ type: 'runCadenceNow', id: c.id })} size="sm" variant="outline">
          <Play aria-hidden="true" />
          Run now
        </Button>
        <Button aria-pressed={selected} onClick={onHistory} size="sm" variant="ghost">
          <History aria-hidden="true" />
          Runs
        </Button>
        <Button aria-pressed={editing} onClick={onSchedule} size="sm" variant="ghost">
          <CalendarClock aria-hidden="true" />
          Change schedule
        </Button>
      </div>
    </li>
  );
}

export interface HousekeepingProps {
  /** Every cadence in the snapshot; the built-in ones are picked out here. */
  cadences: readonly CadenceView[];
  now: number;
  /** The cadence whose runs show on the side, if any. */
  historyId: string | null;
  /** The cadence whose schedule editor shows on the side, if any. */
  scheduleId: string | null;
  onHistory: (id: string) => void;
  onSchedule: (id: string) => void;
  onError: (msg: string) => void;
}

/** The Housekeeping section: built-in jobs in MAINTENANCE_JOB_ORDER. */
export function Housekeeping({ cadences, now, historyId, scheduleId, onHistory, onSchedule, onError }: HousekeepingProps) {
  const headingId = useId();
  const jobs = MAINTENANCE_JOB_ORDER.flatMap((job) => {
    const c = cadences.find((x) => jobOf(x) === job);
    return c ? [{ job, c }] : [];
  });

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3" data-testid="housekeeping">
      <header className="flex flex-col gap-1">
        <h2 className="m-0 flex items-center gap-2 font-display text-base font-semibold" id={headingId}>
          <Wrench aria-hidden="true" className="size-4 text-honey-text" />
          Housekeeping
        </h2>
        <p className="m-0 flex items-start gap-2 text-sm text-muted" data-testid="housekeeping-note">
          <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-honey-text" />
          <span>{HOUSEKEEPING_NOTE}</span>
        </p>
      </header>
      {jobs.length === 0 ? (
        <p className="m-0 text-sm text-muted">The built-in jobs show here once the hive has started.</p>
      ) : (
        <ul aria-label="Built-in jobs" className="m-0 flex list-none flex-col gap-3 p-0">
          {jobs.map(({ job, c }) => (
            <HousekeepingRow
              c={c}
              editing={scheduleId === c.id}
              job={job}
              key={c.id}
              now={now}
              onError={onError}
              onHistory={() => onHistory(c.id)}
              onSchedule={() => onSchedule(c.id)}
              selected={historyId === c.id}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Change a built-in job's schedule (interval or weekly), nothing else. Saving sends `updateCadence` with the same
 * name and goal and `when: { type: 'maintenance', job, schedule }`; the hive keeps everything else as it was.
 */
export function ScheduleEditor({ cadence, onDone }: { cadence: CadenceView; onDone: () => void }) {
  const job = jobOf(cadence);
  const current: ScheduleWhen = scheduleOf(cadence.when) ?? MAINTENANCE_JOBS[job ?? 'brain-audit'].schedule;
  const [kind, setKind] = useState<ScheduleWhen['type']>(current.type);
  const [draft, setDraft] = useState(() => scheduleDraftOf(current));
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const titleId = useId();

  if (!job) return null;

  const resetToDefault = () => {
    const s = MAINTENANCE_JOBS[job].schedule;
    setKind(s.type);
    setDraft(scheduleDraftOf(s));
    setProblems([]);
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const { problems: p, when } = checkSchedule(kind, draft);
    setProblems(p);
    if (!when) return;
    setBusy(true);
    const r = await runCommand({
      type: 'updateCadence',
      id: cadence.id,
      cadence: {
        name: cadence.name,
        goal: cadence.goal,
        when: { type: 'maintenance', job, schedule: when },
        budgetTokens: cadence.budgetTokens,
        autonomy: cadence.autonomy,
        enabled: cadence.enabled,
      },
    });
    setBusy(false);
    if (!r.ok) setProblems([r.error]);
    else onDone();
  };

  return (
    <form
      aria-labelledby={titleId}
      className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4"
      data-testid="schedule-editor"
      noValidate
      onSubmit={(ev) => void submit(ev)}
    >
      <header className="flex flex-col gap-1">
        <h2 className="m-0 font-display text-base font-semibold" id={titleId}>
          Schedule for "{cadence.name}"
        </h2>
        <p className="m-0 text-sm text-muted">Now: {cadence.whenText}</p>
      </header>

      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className="mb-2 p-0 text-sm text-muted">When</legend>
        <ScheduleKindPicker kind={kind} onChange={setKind} />
        <ScheduleFields draft={draft} kind={kind} onChange={(patch) => setDraft((x) => ({ ...x, ...patch }))} />
      </fieldset>

      {problems.length ? (
        <InlineAlert
          message={
            <ul className="m-0 list-disc pl-4">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          }
          onDismiss={() => setProblems([])}
          title="Check the schedule"
          tone="error"
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy} type="submit">
          {busy ? 'Saving…' : 'Save schedule'}
        </Button>
        <Button onClick={onDone} type="button" variant="outline">
          Cancel
        </Button>
        <Button className="ml-auto" onClick={resetToDefault} type="button" variant="ghost">
          Use the default schedule
        </Button>
      </div>
    </form>
  );
}
