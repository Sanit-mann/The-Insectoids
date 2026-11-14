import type { ApprovalKind, DigestCadence, DigestGoal, DigestView, GoalStatusView } from '@insectoids/shared';
import {
  Ban,
  CheckCircle2,
  ChevronRight,
  Coffee,
  Hourglass,
  Inbox,
  LoaderCircle,
  type LucideIcon,
  PlayCircle,
  Wrench,
  XCircle,
} from 'lucide-react';
import { useId } from 'react';
import { KIND_META, ago } from '@/components/approvals/kinds';
import { OUTCOME, whenWords } from '@/components/cadence/cadence-words';
import { openScreen } from '@/components/changes/navigate';
import { formatTokens, formatUsd } from '@/components/hive/format';
import { EmptyState } from '@/components/kokonutui/empty-state';
import { Button } from '@/components/ui/button';
import { openGoal } from '@/lib/goal-nav';
import { cn } from '@/lib/utils';

/**
 * "While you were away" (Cadence 05-D8; App 07; Phase 3 B1): what the hive did on its own since the user last read
 * it. Waits-for-you first, then each cadence (user-made first, then built-in jobs) with its goals and notable lines.
 * Status is always words + an icon, never colour alone. Shown in the auto-opening dialog and on the Cadence screen.
 */

const GOAL_ICON: Record<GoalStatusView, { icon: LucideIcon; className: string }> = {
  done: { icon: CheckCircle2, className: 'text-st-done' },
  stuck: { icon: XCircle, className: 'text-st-blocked' },
  cancelled: { icon: Ban, className: 'text-muted' },
  awaiting_approval: { icon: Hourglass, className: 'text-st-waiting' },
  running: { icon: PlayCircle, className: 'text-st-working' },
  planning: { icon: LoaderCircle, className: 'text-st-working' },
};

/** The run-log outcome in words with its icon; an outcome this build doesn't know shows as its raw word. */
function outcomeMeta(outcome: string): { label: string; icon: LucideIcon; className: string } {
  return (OUTCOME as Record<string, { label: string; icon: LucideIcon; className: string } | undefined>)[outcome] ?? {
    label: outcome,
    icon: CheckCircle2,
    className: 'text-muted',
  };
}

function kindWords(kind: string, n: number): { label: string; icon: LucideIcon } {
  const meta = (KIND_META as Record<string, (typeof KIND_META)[ApprovalKind] | undefined>)[kind];
  if (!meta) return { label: kind, icon: Inbox };
  return { label: n === 1 ? meta.label : meta.plural, icon: meta.icon };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function Totals({ totals }: { totals: DigestView['totals'] }) {
  const items: Array<{ key: string; label: string; value: string }> = [
    { key: 'runs', label: 'Runs', value: String(totals.runs) },
    { key: 'done', label: 'Done', value: String(totals.goalsDone) },
    { key: 'failed', label: 'Failed or stuck', value: String(totals.goalsFailed) },
    { key: 'open', label: 'Still open', value: String(totals.goalsOpen) },
    { key: 'tokens', label: 'Tokens', value: formatTokens(totals.tokens) },
  ];
  if (totals.costUsd > 0) items.push({ key: 'cost', label: 'Cost', value: formatUsd(totals.costUsd) });
  if (totals.problems > 0) items.push({ key: 'problems', label: 'Runs with problems', value: String(totals.problems) });
  items.push({ key: 'jobs', label: 'Housekeeping jobs', value: String(totals.jobs) });
  return (
    <dl aria-label="Totals" className="m-0 flex flex-wrap gap-2" data-testid="digest-totals">
      {items.map((i) => (
        <div className="flex min-w-[84px] flex-col gap-0.5 rounded-[10px] border border-line bg-surface-2/50 px-3 py-2" data-testid="digest-total" data-total={i.key} key={i.key}>
          <dt className="text-[11px] text-muted">{i.label}</dt>
          <dd className="m-0 font-mono text-[15px] font-semibold tabular-nums">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Waiting({ waiting, onLeave }: { waiting: DigestView['waiting']; onLeave: () => void }) {
  const headingId = useId();
  const kinds = Object.entries(waiting.byKind).filter(([, n]) => n > 0);
  const open = () => {
    onLeave();
    openScreen('approvals');
  };
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-[14px] border border-st-waiting/40 bg-st-waiting/10 p-4" data-testid="digest-waiting">
      <div className="flex flex-wrap items-center gap-2">
        <Hourglass aria-hidden="true" className="size-4 text-st-waiting" />
        <h3 className="m-0 font-display text-[15px] font-semibold" id={headingId}>
          Waits for you
        </h3>
        <span className="text-sm text-muted" data-testid="digest-waiting-total">
          {plural(waiting.total, 'approval', 'approvals')}
        </span>
        <Button className="ml-auto" onClick={open} size="sm" variant="outline">
          Open Approvals
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
      {kinds.length > 0 ? (
        <ul aria-label="Waiting by kind" className="m-0 flex list-none flex-wrap gap-2 p-0">
          {kinds.map(([kind, n]) => {
            const w = kindWords(kind, n);
            return (
              <li className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs" data-kind={kind} data-testid="digest-waiting-kind" key={kind}>
                <w.icon aria-hidden="true" className="size-3.5 text-st-waiting" />
                {n} {w.label}
              </li>
            );
          })}
        </ul>
      ) : null}
      {waiting.items.length > 0 ? (
        <ul aria-label="Oldest waiting" className="m-0 flex list-none flex-col gap-1 p-0">
          {waiting.items.map((a) => {
            const Icon = KIND_META[a.kind]?.icon ?? Inbox;
            return (
              <li key={a.id}>
                <button
                  className="flex min-h-10 w-full items-center gap-2 rounded-[10px] px-2 text-left text-sm outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-honey"
                  data-approval-id={a.id}
                  data-testid="digest-waiting-item"
                  onClick={open}
                  type="button"
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-st-waiting" />
                  <span className="min-w-0 flex-1 truncate">{a.title}</span>
                  <span className="shrink-0 text-xs text-muted">
                    {KIND_META[a.kind]?.label ?? a.kind} · {ago(a.createdAt)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function GoalRow({ g, onLeave }: { g: DigestGoal; onLeave: () => void }) {
  const meta = GOAL_ICON[g.status] ?? GOAL_ICON.running;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] border border-line bg-surface px-3 py-2" data-goal-id={g.goalId} data-status={g.status} data-testid="digest-goal">
      <meta.icon aria-hidden="true" className={cn('size-4 shrink-0', meta.className)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium" title={g.title}>
          {g.title}
        </span>
        <span className={cn('text-xs font-medium', meta.className)} data-testid="digest-goal-outcome">
          {g.outcome}
        </span>
      </div>
      <span className="shrink-0 font-mono text-xs text-muted tabular-nums" data-testid="digest-goal-spent">
        {formatTokens(g.spentTokens)} tokens{g.spentUsd > 0 ? ` · ${formatUsd(g.spentUsd)}` : ''}
      </span>
      <Button
        aria-label={`Open goal: ${g.title}`}
        onClick={() => {
          onLeave();
          openGoal(g.goalId);
        }}
        size="sm"
        variant="ghost"
      >
        Open goal
        <ChevronRight aria-hidden="true" />
      </Button>
    </li>
  );
}

function CadenceBlock({ c, now, onLeave }: { c: DigestCadence; now: number; onLeave: () => void }) {
  const headingId = useId();
  const outcomes = Object.entries(c.outcomes).filter(([, n]) => n > 0);
  return (
    <li aria-labelledby={headingId} className="flex flex-col gap-2.5 rounded-[14px] border border-line bg-surface p-4" data-built-in={c.builtIn} data-cadence-id={c.cadenceId} data-testid="digest-cadence">
      <div className="flex flex-wrap items-center gap-2">
        {c.builtIn ? <Wrench aria-hidden="true" className="size-4 text-muted" /> : null}
        <h4 className="m-0 min-w-0 truncate font-display text-[15px] font-semibold" id={headingId}>
          {c.name}
        </h4>
        {c.builtIn ? (
          <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted" data-testid="digest-built-in">
            Built-in
          </span>
        ) : null}
      </div>
      {outcomes.length > 0 ? (
        <ul aria-label="Runs by outcome" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs">
          {outcomes.map(([outcome, n]) => {
            const m = outcomeMeta(outcome);
            return (
              <li className="inline-flex items-center gap-1.5" data-outcome={outcome} data-testid="digest-outcome" key={outcome}>
                <m.icon aria-hidden="true" className={cn('size-3.5', m.className)} />
                <span>
                  <span className={cn('font-medium', m.className)}>{m.label}</span>: {n}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {c.goals.length > 0 ? (
        <ul aria-label={`Goals ${c.name} started`} className="m-0 flex list-none flex-col gap-1.5 p-0">
          {c.goals.map((g) => (
            <GoalRow g={g} key={g.goalId} onLeave={onLeave} />
          ))}
        </ul>
      ) : null}
      {c.lines.length > 0 ? (
        <ul aria-label={`What ${c.name} noted`} className="m-0 flex list-none flex-col gap-1 p-0">
          {c.lines.map((l, i) => {
            const m = outcomeMeta(l.outcome);
            return (
              <li className="flex items-start gap-2 text-xs" data-outcome={l.outcome} data-testid="digest-line" key={`${l.at}-${i}`}>
                <m.icon aria-hidden="true" className={cn('mt-0.5 size-3.5 shrink-0', m.className)} />
                <span className="min-w-0 flex-1">
                  <span className={cn('font-medium', m.className)}>{m.label}</span>
                  <span className="text-muted"> · </span>
                  {l.message}
                </span>
                <time className="shrink-0 font-mono text-muted" dateTime={new Date(l.at).toISOString()}>
                  {whenWords(l.at, now)}
                </time>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

export interface AwayDigestProps {
  view: DigestView;
  now: number;
  /** Called before a button leaves this view (opening a goal or Approvals), e.g. to close the dialog. */
  onLeave?: () => void;
}

export function AwayDigest({ view, now, onLeave = () => {} }: AwayDigestProps) {
  const headingId = useId();
  const nothingRan = view.cadences.length === 0 && view.totals.runs === 0 && view.totals.jobs === 0;

  return (
    <div className="flex flex-col gap-4" data-testid="digest-view">
      {nothingRan ? (
        <EmptyState
          className="py-4"
          description={`Since ${whenWords(view.since, now)}, no cadence or built-in job ran on its own.`}
          icon={Coffee}
          title="Nothing ran while you were away."
        />
      ) : (
        <>
          <p className="m-0 text-[15px] font-medium" data-testid="digest-headline">
            {view.headline ?? `What the hive did on its own since ${whenWords(view.since, now)}.`}
          </p>
          <Totals totals={view.totals} />
        </>
      )}

      {view.waiting.total > 0 ? <Waiting onLeave={onLeave} waiting={view.waiting} /> : null}

      {view.cadences.length > 0 ? (
        <section aria-labelledby={headingId} className="flex flex-col gap-2">
          <h3 className="m-0 font-display text-[15px] font-semibold" id={headingId}>
            What ran
          </h3>
          <ul aria-labelledby={headingId} className="m-0 flex list-none flex-col gap-3 p-0" data-testid="digest-cadences">
            {view.cadences.map((c) => (
              <CadenceBlock c={c} key={c.cadenceId} now={now} onLeave={onLeave} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
