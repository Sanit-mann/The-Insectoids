import {
  type CadenceAutonomy,
  type CadenceFields,
  CadenceInputSchema,
  type CadenceView,
  DEFAULT_CADENCE_BUDGET_TOKENS,
  DEFAULT_WEBHOOK_TRUST,
  FILE_SETTLE_MS,
  FilePatternSchema,
  type HiveEventTrigger,
  MAX_LISTED_FILES,
  ProjectFolderSchema,
  type WebhookTrust,
} from '@insectoids/shared';
import { FolderOpen, GitMerge, Lock, Repeat, Trash2 } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { HoldButton } from '@/components/kokonutui/hold-button';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { AUTONOMY, AUTONOMY_ORDER, HIVE_EVENTS, HIVE_EVENT_ORDER, TRUST, TRUST_ORDER } from './cadence-words';
import { DEFAULT_SCHEDULE_DRAFT, ScheduleFields, type Unit, checkSchedule, inputCls, scheduleDraftOf } from './ScheduleFields';

/**
 * Create or edit a cadence (Cadence 05; Phase 3 A1, A3, A4): when (every N minutes/hours, weekly at a local time,
 * when files change in a project folder, when something happens in the hive, or when a webhook is called),
 * what (a goal for the Queen), and limits (a token budget and how much may start without the user).
 * The form checks everything in words first and only sends what `CadenceInputSchema` accepts.
 */

export type { CadenceFields };

/** The user's own kinds of cadence. Built-in maintenance jobs (A5) are never offered: only the hive makes those. */
type Kind = 'interval' | 'weekly' | 'file' | 'event' | 'webhook';
const KINDS: ReadonlyArray<{ kind: Kind; label: string }> = [
  { kind: 'interval', label: 'Every few minutes or hours' },
  { kind: 'weekly', label: 'On days of the week' },
  { kind: 'file', label: 'When files change in a folder' },
  { kind: 'event', label: 'When something happens in the hive' },
  { kind: 'webhook', label: 'A webhook is called' },
];

interface Draft {
  name: string;
  kind: Kind;
  every: string;
  unit: Unit;
  days: number[];
  time: string;
  folder: string;
  pattern: string;
  eventOn: HiveEventTrigger;
  /** '' = any goal. */
  eventFrom: string;
  trust: WebhookTrust;
  goal: string;
  budget: string;
  autonomy: CadenceAutonomy;
}

function draftOf(c: CadenceView | null): Draft {
  const base: Draft = {
    name: '',
    kind: 'interval',
    ...DEFAULT_SCHEDULE_DRAFT,
    folder: '',
    pattern: '',
    eventOn: 'goal-done',
    eventFrom: '',
    trust: DEFAULT_WEBHOOK_TRUST,
    goal: '',
    budget: String(DEFAULT_CADENCE_BUDGET_TOKENS),
    autonomy: 'small-plans',
  };
  if (!c) return base;
  const d: Draft = { ...base, name: c.name, goal: c.goal, budget: String(c.budgetTokens), autonomy: c.autonomy };
  if (c.when.type === 'interval' || c.when.type === 'weekly') return { ...d, kind: c.when.type, ...scheduleDraftOf(c.when) };
  // Built-in jobs aren't edited here (the Housekeeping schedule editor does that); fall back to their schedule.
  if (c.when.type === 'maintenance') return { ...d, kind: c.when.schedule.type, ...scheduleDraftOf(c.when.schedule) };
  if (c.when.type === 'file') return { ...d, kind: 'file', folder: c.when.folder, pattern: c.when.pattern ?? '' };
  if (c.when.type === 'webhook') return { ...d, kind: 'webhook', trust: c.when.trust };
  return { ...d, kind: 'event', eventOn: c.when.on, eventFrom: c.when.cadenceId ?? '' };
}

/** Everything wrong with the draft, in words; empty when it can be sent. */
function check(d: Draft, enabled: boolean): { problems: string[]; input: CadenceFields | null } {
  const problems: string[] = [];
  if (!d.name.trim()) problems.push('Give the cadence a name.');
  if (d.name.trim().length > 80) problems.push('Keep the name under 80 characters.');
  let when: CadenceFields['when'] | null = null;
  if (d.kind === 'interval' || d.kind === 'weekly') {
    const s = checkSchedule(d.kind, d);
    problems.push(...s.problems);
    when = s.when;
  } else if (d.kind === 'file') {
    if (!d.folder.trim()) problems.push('Folder: name a folder inside the project, like inbox or docs/incoming.');
    const folder = d.folder.trim() ? ProjectFolderSchema.safeParse(d.folder) : null;
    if (folder && !folder.success) problems.push(...folder.error.issues.map((i) => `Folder: ${i.message}`));
    const pattern = d.pattern.trim() ? FilePatternSchema.safeParse(d.pattern) : null;
    if (pattern && !pattern.success) problems.push(...pattern.error.issues.map((i) => `File pattern: ${i.message}`));
    if (folder?.success && (!pattern || pattern.success)) when = { type: 'file', folder: folder.data, pattern: pattern ? pattern.data : null };
  } else if (d.kind === 'webhook') {
    when = { type: 'webhook', trust: d.trust };
  } else {
    when = { type: 'event', on: d.eventOn, cadenceId: d.eventOn === 'goal-done' && d.eventFrom ? d.eventFrom : null };
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
  /**
   * Cadences a "goal finishes" trigger can follow (A3): this project's other cadences, minus event cadences
   * (their goals never trigger another event cadence, so following one would never fire).
   */
  others?: ReadonlyArray<{ id: string; name: string }>;
}

export function CadenceForm({ cadence, onSave, onCancel, onDelete, others = [] }: CadenceFormProps) {
  const [d, setD] = useState<Draft>(() => draftOf(cadence));
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const uid = useId();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const editing = cadence !== null;
  const titleId = `${uid}-title`;
  // The form opens beside the list: move focus to its first field so keyboard users land in it (WCAG 2.4.3).
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);

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
    const step = ev.key === 'ArrowDown' || ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowUp' || ev.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    ev.preventDefault();
    const i = KINDS.findIndex((k) => k.kind === d.kind);
    const next = KINDS[(i + step + KINDS.length) % KINDS.length]!.kind;
    set('kind', next);
    document.getElementById(`${uid}-kind-${next}`)?.focus();
  };
  const autonomyKey = (ev: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = ev.key === 'ArrowDown' || ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowUp' || ev.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    ev.preventDefault();
    const next = AUTONOMY_ORDER[(i + step + AUTONOMY_ORDER.length) % AUTONOMY_ORDER.length]!;
    set('autonomy', next);
    document.getElementById(`${uid}-autonomy-${next}`)?.focus();
  };
  const eventKey = (ev: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = ev.key === 'ArrowDown' || ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowUp' || ev.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    ev.preventDefault();
    const next = HIVE_EVENT_ORDER[(i + step + HIVE_EVENT_ORDER.length) % HIVE_EVENT_ORDER.length]!;
    set('eventOn', next);
    document.getElementById(`${uid}-event-${next}`)?.focus();
  };
  const trustKey = (ev: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = ev.key === 'ArrowDown' || ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowUp' || ev.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    ev.preventDefault();
    const next = TRUST_ORDER[(i + step + TRUST_ORDER.length) % TRUST_ORDER.length]!;
    set('trust', next);
    document.getElementById(`${uid}-trust-${next}`)?.focus();
  };

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
        <input className={inputCls} maxLength={80} onChange={(e) => set('name', e.target.value)} placeholder="Weekly report" ref={nameRef} value={d.name} />
      </label>

      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className="mb-2 p-0 text-sm text-muted">When</legend>
        <div aria-label="Kind of schedule" className="flex flex-wrap gap-2" role="radiogroup">
          {KINDS.map(({ kind: k, label }) => (
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
              {label}
            </button>
          ))}
        </div>
        {d.kind === 'interval' ? (
          <ScheduleFields draft={d} kind="interval" onChange={(patch) => setD((x) => ({ ...x, ...patch }))} />
        ) : d.kind === 'file' ? (
          <div className="flex flex-col gap-3" data-testid="cadence-file-fields">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted">Folder in the project</span>
                <input
                  aria-describedby={`${uid}-folder-hint`}
                  className={cn(inputCls, 'w-64 font-mono')}
                  maxLength={300}
                  onChange={(e) => set('folder', e.target.value)}
                  placeholder="inbox"
                  value={d.folder}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted">Only files named like (optional)</span>
                <input className={cn(inputCls, 'w-40 font-mono')} maxLength={100} onChange={(e) => set('pattern', e.target.value)} placeholder="*.md" value={d.pattern} />
              </label>
            </div>
            <p className="m-0 flex items-start gap-2 text-xs text-muted" id={`${uid}-folder-hint`}>
              <FolderOpen aria-hidden="true" className="mt-px size-3.5 shrink-0 text-honey-text" />
              <span>
                A folder inside the project, like inbox or docs/incoming. When files are added or changed there, the hive waits {Math.round(FILE_SETTLE_MS / 1000)}{' '}
                seconds for things to settle, then starts one run that lists the files (up to {MAX_LISTED_FILES}). Deleted files don't count.
              </span>
            </p>
          </div>
        ) : d.kind === 'webhook' ? (
          <div className="flex flex-col gap-3" data-testid="cadence-webhook-fields">
            <div aria-label="How much to trust the caller" className="flex flex-col gap-2" role="radiogroup">
              {TRUST_ORDER.map((t, i) => (
                <button
                  aria-checked={d.trust === t}
                  aria-describedby={`${uid}-trust-${t}-sentence`}
                  aria-labelledby={`${uid}-trust-${t}-label`}
                  className={cn(
                    'flex min-h-10 items-start gap-3 rounded-[10px] border px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-honey',
                    d.trust === t ? 'border-honey bg-honey/10' : 'border-line bg-ground hover:bg-surface-2',
                  )}
                  data-trust={t}
                  id={`${uid}-trust-${t}`}
                  key={t}
                  onClick={() => set('trust', t)}
                  onKeyDown={(ev) => trustKey(ev, i)}
                  role="radio"
                  tabIndex={d.trust === t ? 0 : -1}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border', d.trust === t ? 'border-honey' : 'border-line')}
                  >
                    {d.trust === t ? <span className="size-2 rounded-full bg-honey" /> : null}
                  </span>
                  <span className="flex flex-col">
                    <span className="text-sm font-semibold text-text" id={`${uid}-trust-${t}-label`}>
                      {TRUST[t].label}
                    </span>
                    <span className="text-xs text-muted" id={`${uid}-trust-${t}-sentence`}>
                      {TRUST[t].sentence}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <p className="m-0 flex items-start gap-2 text-xs text-muted">
              <Lock aria-hidden="true" className="mt-px size-3.5 shrink-0 text-honey-text" />
              <span>
                The webhook&apos;s address works on this computer only. Every call needs its secret, and every call is listed in the cadence&apos;s runs, refused ones
                too. The address and secret show under Runs once the cadence is saved.
              </span>
            </p>
          </div>
        ) : d.kind === 'event' ? (
          <div className="flex flex-col gap-3" data-testid="cadence-event-fields">
            <div aria-label="What happens" className="flex flex-col gap-2" role="radiogroup">
              {HIVE_EVENT_ORDER.map((on, i) => (
                <button
                  aria-checked={d.eventOn === on}
                  className={cn(
                    'flex min-h-10 items-center gap-3 rounded-[10px] border px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-honey',
                    d.eventOn === on ? 'border-honey bg-honey/10' : 'border-line bg-ground hover:bg-surface-2',
                  )}
                  id={`${uid}-event-${on}`}
                  key={on}
                  onClick={() => set('eventOn', on)}
                  onKeyDown={(ev) => eventKey(ev, i)}
                  role="radio"
                  tabIndex={d.eventOn === on ? 0 : -1}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border', d.eventOn === on ? 'border-honey' : 'border-line')}
                  >
                    {d.eventOn === on ? <span className="size-2 rounded-full bg-honey" /> : null}
                  </span>
                  <span className="font-semibold text-text">{HIVE_EVENTS[on].label}</span>
                </button>
              ))}
            </div>
            {d.eventOn === 'goal-done' ? (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted">Only goals from cadence</span>
                <select className={cn(inputCls, 'w-72')} onChange={(e) => set('eventFrom', e.target.value)} value={d.eventFrom}>
                  <option value="">Any goal</option>
                  {others.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                  {d.eventFrom && !others.some((o) => o.id === d.eventFrom) ? <option value={d.eventFrom}>A removed cadence</option> : null}
                </select>
              </label>
            ) : null}
            <p className="m-0 flex items-start gap-2 text-xs text-muted">
              <Repeat aria-hidden="true" className="mt-px size-3.5 shrink-0 text-honey-text" />
              <span>Runs started this way never start other event cadences, and a cadence never starts from its own goals, so they can't loop.</span>
            </p>
          </div>
        ) : (
          <ScheduleFields draft={d} kind="weekly" onChange={(patch) => setD((x) => ({ ...x, ...patch }))} />
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
