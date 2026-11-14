import {
  type CadenceAutonomy,
  type CadenceFields,
  CadenceInputSchema,
  type CadenceView,
  DEFAULT_CADENCE_BUDGET_TOKENS,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
} from '@insectoids/shared';
import { GitMerge, Trash2 } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useId, useState } from 'react';
import { HoldButton } from '@/components/kokonutui/hold-button';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { AUTONOMY, AUTONOMY_ORDER, WEEK } from './cadence-words';

/**
 * Create or edit a cadence (Cadence 05; Phase 3 A1): when (every N minutes/hours, or weekly at a local time),
 * what (a goal for the Queen), and limits (a token budget and how much may start without the user).
 * The form checks everything in words first and only sends what `CadenceInputSchema` accepts.
 */

const inputCls = 'min-h-10 rounded-[10px] border border-line bg-ground px-3 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-honey';

export type { CadenceFields };

type Unit = 'minutes' | 'hours';
type Kind = 'interval' | 'weekly';

interface Draft {
  name: string;
  kind: Kind;
  every: string;
  unit: Unit;
  days: number[];
  time: string;
  goal: string;
  budget: string;
  autonomy: CadenceAutonomy;
}

function draftOf(c: CadenceView | null): Draft {
  const base: Draft = {
    name: '',
    kind: 'interval',
    every: '1',
    unit: 'hours',
    days: [1],
    time: '09:00',
    goal: '',
    budget: String(DEFAULT_CADENCE_BUDGET_TOKENS),
    autonomy: 'small-plans',
  };
  if (!c) return base;
  const d: Draft = { ...base, name: c.name, goal: c.goal, budget: String(c.budgetTokens), autonomy: c.autonomy };
  if (c.when.type === 'interval') {
    const hours = c.when.everyMinutes % 60 === 0;
    return { ...d, kind: 'interval', every: String(hours ? c.when.everyMinutes / 60 : c.when.everyMinutes), unit: hours ? 'hours' : 'minutes' };
  }
  return { ...d, kind: 'weekly', days: [...c.when.days], time: c.when.time };
}

/** Everything wrong with the draft, in words; empty when it can be sent. */
function check(d: Draft, enabled: boolean): { problems: string[]; input: CadenceFields | null } {
  const problems: string[] = [];
  if (!d.name.trim()) problems.push('Give the cadence a name.');
  if (d.name.trim().length > 80) problems.push('Keep the name under 80 characters.');
  let when: CadenceFields['when'] | null = null;
  if (d.kind === 'interval') {
    const n = Number(d.every);
    const minutes = d.unit === 'hours' ? n * 60 : n;
    if (!Number.isInteger(n) || n < 1) problems.push('How often: use a whole number, like 2.');
    else if (minutes < MIN_INTERVAL_MINUTES) problems.push(`How often: the shortest interval is ${MIN_INTERVAL_MINUTES} minutes.`);
    else if (minutes > MAX_INTERVAL_MINUTES) problems.push('How often: the longest interval is 4 weeks.');
    else when = { type: 'interval', everyMinutes: minutes };
  } else {
    if (!d.days.length) problems.push('Pick at least one day.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.time)) problems.push('Pick a time, like 09:00.');
    if (d.days.length && /^([01]\d|2[0-3]):[0-5]\d$/.test(d.time)) when = { type: 'weekly', days: [...d.days].sort((a, b) => a - b), time: d.time };
  }
  if (d.goal.trim().length < 3) problems.push('Tell the Queen what to do each time (at least 3 characters).');
  if (d.goal.trim().length > 8000) problems.push('Keep the goal under 8,000 characters.');
  const budget = Number(d.budget);
  if (!Number.isInteger(budget) || budget < 1_000 || budget > 5_000_000) problems.push('Token budget: a whole number from 1,000 to 5,000,000.');
  if (problems.length || !when) return { problems, input: null };
  const parsed = CadenceInputSchema.safeParse({ name: d.name.trim(), when, goal: d.goal.trim(), budgetTokens: budget, autonomy: d.autonomy, enabled });
  if (!parsed.success) return { problems: parsed.error.issues.map((i) => i.message), input: null };
  return { problems: [], input: parsed.data };
}

export interface CadenceFormProps {
  /** null to create a new cadence. */
  cadence: CadenceView | null;
  onSave: (input: CadenceFields) => Promise<string | null>;
  onCancel: () => void;
  /** Editing only: removes the cadence (its history stays). */
  onDelete?: (() => Promise<void>) | undefined;
}

export function CadenceForm({ cadence, onSave, onCancel, onDelete }: CadenceFormProps) {
  const [d, setD] = useState<Draft>(() => draftOf(cadence));
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const uid = useId();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const editing = cadence !== null;
  const titleId = `${uid}-title`;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const { problems: p, input } = check(d, cadence?.enabled ?? true);
    setProblems(p);
    if (!input) return;
    setBusy(true);
    const err = await onSave(input);
    setBusy(false);
    if (err) setProblems([err]);
  };

  const kindKey = (ev: KeyboardEvent<HTMLButtonElement>) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key)) {
      ev.preventDefault();
      const next: Kind = d.kind === 'interval' ? 'weekly' : 'interval';
      set('kind', next);
      document.getElementById(`${uid}-kind-${next}`)?.focus();
    }
  };
  const autonomyKey = (ev: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = ev.key === 'ArrowDown' || ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowUp' || ev.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    ev.preventDefault();
    const next = AUTONOMY_ORDER[(i + step + AUTONOMY_ORDER.length) % AUTONOMY_ORDER.length]!;
    set('autonomy', next);
    document.getElementById(`${uid}-autonomy-${next}`)?.focus();
  };
  const toggleDay = (day: number) => set('days', d.days.includes(day) ? d.days.filter((x) => x !== day) : [...d.days, day]);

  return (
    <form
      aria-labelledby={titleId}
      className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4"
      data-testid="cadence-form"
      noValidate
      onSubmit={(ev) => void submit(ev)}
    >
      <h2 className="m-0 font-display text-base font-semibold" id={titleId}>
        {editing ? `Edit "${cadence.name}"` : 'New cadence'}
      </h2>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Name</span>
        <input className={inputCls} maxLength={80} onChange={(e) => set('name', e.target.value)} placeholder="Weekly report" value={d.name} />
      </label>

      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className="mb-2 p-0 text-sm text-muted">When</legend>
        <div aria-label="Kind of schedule" className="flex flex-wrap gap-2" role="radiogroup">
          {(['interval', 'weekly'] as const).map((k) => (
            <button
              aria-checked={d.kind === k}
              className={cn(
                'inline-flex min-h-10 items-center rounded-full border px-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-honey',
                d.kind === k ? 'border-honey text-honey-text' : 'border-line bg-ground text-text hover:bg-surface-2',
              )}
              id={`${uid}-kind-${k}`}
              key={k}
              onClick={() => set('kind', k)}
              onKeyDown={kindKey}
              role="radio"
              tabIndex={d.kind === k ? 0 : -1}
              type="button"
            >
              {k === 'interval' ? 'Every few minutes or hours' : 'On days of the week'}
            </button>
          ))}
        </div>
        {d.kind === 'interval' ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">Every</span>
              <input
                className={cn(inputCls, 'w-24')}
                inputMode="numeric"
                min={1}
                onChange={(e) => set('every', e.target.value)}
                type="number"
                value={d.every}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">Unit</span>
              <select className={inputCls} onChange={(e) => set('unit', e.target.value as Unit)} value={d.unit}>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </select>
            </label>
            <p className="m-0 pb-2 text-xs text-muted">At least every {MIN_INTERVAL_MINUTES} minutes, at most every 4 weeks.</p>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div aria-label="Days" className="flex flex-wrap gap-1.5" role="group">
              {WEEK.map((w) => (
                <button
                  aria-label={w.long}
                  aria-pressed={d.days.includes(w.day)}
                  className={cn(
                    'inline-flex min-h-10 min-w-12 items-center justify-center rounded-[10px] border px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-honey',
                    d.days.includes(w.day) ? 'border-honey bg-honey/10 font-semibold text-honey-text' : 'border-line bg-ground text-text hover:bg-surface-2',
                  )}
                  key={w.day}
                  onClick={() => toggleDay(w.day)}
                  type="button"
                >
                  {w.short}
                </button>
              ))}
            </div>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">Time (your local time)</span>
              <input className={cn(inputCls, 'w-32 font-mono')} onChange={(e) => set('time', e.target.value)} step={60} type="time" value={d.time} />
            </label>
          </div>
        )}
      </fieldset>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">What the Queen should do each time</span>
        <textarea
          className={cn(inputCls, 'min-h-24 py-2')}
          maxLength={8000}
          onChange={(e) => set('goal', e.target.value)}
          placeholder="Summarise this week's commits and open issues in docs/reports/weekly.md"
          value={d.goal}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Token budget for each run</span>
        <input className={cn(inputCls, 'w-40 font-mono')} inputMode="numeric" min={1000} onChange={(e) => set('budget', e.target.value)} step={1000} type="number" value={d.budget} />
        <span className="text-xs text-muted">The Treasurer stops new work on a run once it has used this much.</span>
      </label>

      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 p-0 text-sm text-muted">How much may start without you</legend>
        <div aria-label="How much may start without you" className="flex flex-col gap-2" role="radiogroup">
          {AUTONOMY_ORDER.map((a, i) => (
            <button
              aria-checked={d.autonomy === a}
              className={cn(
                'flex min-h-10 items-start gap-3 rounded-[10px] border px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-honey',
                d.autonomy === a ? 'border-honey bg-honey/10' : 'border-line bg-ground hover:bg-surface-2',
              )}
              id={`${uid}-autonomy-${a}`}
              key={a}
              onClick={() => set('autonomy', a)}
              onKeyDown={(ev) => autonomyKey(ev, i)}
              role="radio"
              tabIndex={d.autonomy === a ? 0 : -1}
              type="button"
            >
              <span
                aria-hidden="true"
                className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border', d.autonomy === a ? 'border-honey' : 'border-line')}
              >
                {d.autonomy === a ? <span className="size-2 rounded-full bg-honey" /> : null}
              </span>
              <span className="flex flex-col">
                <span className="text-sm font-semibold text-text">{AUTONOMY[a].label}</span>
                <span className="text-xs text-muted">{AUTONOMY[a].sentence}</span>
              </span>
            </button>
          ))}
        </div>
        <p className="m-0 flex items-center gap-2 text-xs text-muted">
          <GitMerge aria-hidden="true" className="size-3.5 text-honey-text" />
          Merging into your branch, risky actions and new dependencies always wait for you, at every level.
        </p>
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
          title="Check the form"
          tone="error"
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy} type="submit">
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Create cadence'}
        </Button>
        <Button onClick={onCancel} type="button" variant="outline">
          Cancel
        </Button>
        {editing && onDelete ? (
          <div className="ml-auto flex flex-col items-end gap-1">
            <HoldButton
              aria-label={`Hold to delete ${cadence.name}`}
              completeLabel="Deleted"
              data-testid="cadence-delete"
              disabled={busy}
              holdingLabel="Keep holding"
              icon={Trash2}
              onHoldComplete={() => void onDelete()}
              variant="danger"
            >
              Hold to delete
            </HoldButton>
            <span className="text-xs text-muted">Its run history stays in the Brain.</span>
          </div>
        ) : null}
      </div>
    </form>
  );
}
