import type { BudgetsView, EngineCard } from '@insectoids/shared';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Coins,
  GraduationCap,
  Loader,
  Route,
  StopCircle,
  Table2,
  Users,
  Wallet,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useLive } from '@/components/brain/useLive';
import { engineName } from '@/components/connections/engine-names';
import { USAGE_LABEL } from '@/components/connections/EngineUsage';
import { casteLabel, formatTokens, formatUsd } from '@/components/hive/format';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { useHive } from '@/lib/hive-store';
import { cn } from '@/lib/utils';

/**
 * Budgets (App 07; Hive 02-D7, D9; Connections 04-D7; Phase 2 C4): what each goal used against its
 * budget, the last 14 days, spend by role, the subscriptions' windows, and how the Treasurer routed every
 * run and what it has learned.
 *
 * Charts follow the dataviz skill: one measure per chart (tokens and cost are separate charts, never a
 * second axis), a single amber series (--chart, validated: lightness band and >= 3:1 on both surfaces),
 * thin bars with 4px rounded data ends and 2px gaps, a hover/focus tooltip on every bar, and a table view.
 */

const day = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const time = (ms: number): string => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const pct = (n: number): string => `${Math.round(n * 100)}%`;
const roleName = (r: string): string => casteLabel(r);

const OUTCOME: Record<BudgetsView['routing'][number]['outcome'], { label: string; icon: LucideIcon; className: string }> = {
  passed: { label: 'Passed', icon: CheckCircle2, className: 'text-st-done' },
  failed: { label: 'Failed', icon: XCircle, className: 'text-st-blocked' },
  running: { label: 'Running', icon: Loader, className: 'text-st-working' },
  stopped: { label: 'Stopped', icon: StopCircle, className: 'text-st-paused' },
  other: { label: 'Other', icon: CircleDashed, className: 'text-muted' },
};

function Section({ title, icon: Icon, testId, children, aside }: { title: string; icon: LucideIcon; testId: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-4" data-testid={testId}>
      <header className="flex flex-wrap items-center gap-2">
        <Icon aria-hidden="true" className="size-4 text-honey-text" />
        <h2 className="m-0 font-display text-base font-semibold">{title}</h2>
        {aside ? <div className="ml-auto">{aside}</div> : null}
      </header>
      {children}
    </section>
  );
}

/** A used-vs-budget meter with the numbers written out (never the bar alone). */
function Meter({ used, budget }: { used: number; budget: number | null }) {
  if (budget === null || budget <= 0) return <p className="m-0 text-xs text-muted">{formatTokens(used)} tokens used · no budget set for this goal</p>;
  const share = used / budget;
  const over = share > 1;
  return (
    <div className="flex flex-col gap-1">
      <div
        aria-label={`${formatTokens(used)} of ${formatTokens(budget)} tokens used (${pct(share)})`}
        aria-valuemax={budget}
        aria-valuemin={0}
        aria-valuenow={Math.min(used, budget)}
        className="h-2 overflow-hidden rounded-full bg-surface-2"
        role="meter"
      >
        <div className={cn('h-full rounded-full', over ? 'bg-st-blocked' : 'bg-chart')} style={{ width: `${Math.min(100, share * 100)}%` }} />
      </div>
      <p className="m-0 flex items-center gap-1.5 text-xs text-muted">
        {over ? <AlertTriangle aria-hidden="true" className="size-3.5 text-st-blocked" /> : null}
        {formatTokens(used)} of {formatTokens(budget)} tokens ({pct(share)}){over ? ' · over budget' : ''}
      </p>
    </div>
  );
}

/** One measure over the 14 days as vertical bars, with a tooltip on hover/focus and the peak labelled. */
function DayBars({ days, value, format, label }: { days: BudgetsView['days']; value: (d: BudgetsView['days'][number]) => number; format: (n: number) => string; label: string }) {
  const max = Math.max(0, ...days.map(value));
  const peak = days.findIndex((d) => value(d) === max && max > 0);
  return (
    <figure className="m-0 flex flex-col gap-1.5">
      <figcaption className="text-xs font-medium text-muted">{label}</figcaption>
      <ol aria-label={label} className="m-0 flex h-28 list-none items-end gap-[2px] border-b border-line p-0">
        {days.map((d, i) => {
          const v = value(d);
          const h = max > 0 ? Math.max(v > 0 ? 3 : 0, (v / max) * 100) : 0;
          const text = `${day(d.day)}: ${format(v)}`;
          return (
            <li aria-label={text} className="group relative flex h-full min-w-0 flex-1 items-end" key={d.day} tabIndex={0}>
              <span className="block w-full rounded-t-[4px] bg-chart transition-opacity group-hover:opacity-80" style={{ height: `${h}%` }} />
              {i === peak ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute whitespace-nowrap text-[10px] text-muted group-hover:hidden group-focus:hidden',
                    // Keep the label inside the chart at the edges.
                    i >= days.length - 3 ? 'right-0' : i <= 2 ? 'left-0' : 'left-1/2 -translate-x-1/2',
                  )}
                  style={{ bottom: `calc(${h}% + 2px)` }}
                >
                  {format(v)}
                </span>
              ) : null}
              <span
                aria-hidden="true"
                className={cn(
                  'pointer-events-none absolute bottom-full z-10 mb-1 hidden whitespace-nowrap rounded-md border border-line bg-surface-2 px-2 py-1 text-[11px] text-text shadow group-hover:block group-focus:block',
                  i >= days.length - 3 ? 'right-0' : i <= 2 ? 'left-0' : 'left-1/2 -translate-x-1/2',
                )}
              >
                {text}
              </span>
            </li>
          );
        })}
      </ol>
      <div aria-hidden="true" className="flex justify-between text-[10px] text-muted">
        <span>{days[0] ? day(days[0].day) : ''}</span>
        <span>{days.at(-1) ? day(days.at(-1)!.day) : ''}</span>
      </div>
    </figure>
  );
}

function DaysTable({ days }: { days: BudgetsView['days'] }) {
  return (
    <table className="w-full border-collapse text-xs">
      <caption className="sr-only">Tokens, cost and runs per day</caption>
      <thead>
        <tr className="text-left text-muted">
          <th className="py-1 font-medium">Day</th>
          <th className="py-1 text-right font-medium">Tokens</th>
          <th className="py-1 text-right font-medium">Cost</th>
          <th className="py-1 text-right font-medium">Runs</th>
        </tr>
      </thead>
      <tbody>
        {days.map((d) => (
          <tr className="border-t border-line" key={d.day}>
            <td className="py-1">{day(d.day)}</td>
            <td className="py-1 text-right font-mono">{formatTokens(d.tokens)}</td>
            <td className="py-1 text-right font-mono">{formatUsd(d.costUsd)}</td>
            <td className="py-1 text-right font-mono">{d.runs}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Subscriptions({ engines }: { engines: EngineCard[] }) {
  // Engines the hive used this week (or that are near or at a limit) get a row; the rest share one line.
  const used = engines.filter((e) => e.usage.window7d.runs > 0 || e.usage.state !== 'ok');
  const quiet = engines.filter((e) => e.enabled && !used.includes(e));
  if (used.length === 0 && quiet.length === 0) return <p className="m-0 text-sm text-muted">No engine is switched on yet. Turn one on in Connections.</p>;
  return (
    <>
      {used.length > 0 ? <SubscriptionRows engines={used} /> : null}
      {quiet.length > 0 ? (
        <p className="m-0 text-xs text-muted">Not used in the last 7 days: {quiet.map((e) => e.name).join(', ')}.</p>
      ) : null}
    </>
  );
}

function SubscriptionRows({ engines: used }: { engines: EngineCard[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {used.map((e) => (
        <li className="flex flex-col gap-0.5 rounded-xl border border-line px-3 py-2 text-sm" key={e.id}>
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{e.name}</span>
            <span className="text-xs text-muted">{USAGE_LABEL[e.usage.state]}</span>
          </span>
          <span className="text-xs text-muted">
            Last 5 hours: {formatTokens(e.usage.window5h.tokens)} tokens, {formatUsd(e.usage.window5h.costUsd)}
            {e.usage.cap5hUsd !== null ? ` of your ${formatUsd(e.usage.cap5hUsd)} limit` : ''} · Last 7 days: {formatTokens(e.usage.window7d.tokens)} tokens,{' '}
            {formatUsd(e.usage.window7d.costUsd)}
            {e.usage.cap7dUsd !== null ? ` of your ${formatUsd(e.usage.cap7dUsd)} limit` : ''}
            {e.usage.window7d.costEstimated ? ' (cost estimated)' : ''}
          </span>
          {e.usage.message ? <span className="text-xs text-muted">{e.usage.message}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function BudgetsScreen() {
  const { snapshot } = useHive();
  const { live, reload } = useLive('budgets', () => window.insectoids.hive.budgets(), 1500);
  const [table, setTable] = useState(false);

  if (live.state === 'loading') {
    return (
      <div aria-label="Loading budgets" className="flex flex-col gap-3 p-6" data-testid="budgets-screen" role="status">
        {[0, 1, 2].map((i) => (
          <div className="h-28 animate-pulse rounded-2xl bg-surface-2" key={i} />
        ))}
      </div>
    );
  }
  if (live.state === 'error') {
    return (
      <div className="p-6" data-testid="budgets-screen">
        <InlineAlert actions={[{ label: 'Try again', onClick: reload, primary: true }]} message={live.message} title="Could not load budgets" tone="error" />
      </div>
    );
  }

  const b = live.data;
  const maxRole = Math.max(1, ...b.byRole.map((r) => r.tokens));
  const hasDays = b.days.some((d) => d.tokens > 0 || d.costUsd > 0);

  return (
    <div className="flex flex-1 flex-col gap-4 p-6" data-testid="budgets-screen">
      <p className="m-0 max-w-[760px] text-sm text-muted">
        What the hive has spent, against the budgets you set. Costs marked "estimated" are the hive's own estimate when an engine doesn't report
        cost. The Treasurer picks each run's engine, model and effort; its reasons are below.
      </p>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Section icon={Wallet} testId="budget-goals" title="Goals">
          {b.goals.length === 0 ? (
            <p className="m-0 text-sm text-muted">No goals yet. Give the Queen a goal and its spend shows up here.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {b.goals.map((g) => {
                const top = [...g.cards].sort((x, y) => y.tokens - x.tokens).slice(0, 3);
                return (
                  <li className="flex flex-col gap-1.5 rounded-xl border border-line p-3" data-goal={g.id} data-testid="budget-goal" key={g.id}>
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium">{g.title}</span>
                      <span className="text-xs text-muted">{g.status}</span>
                      <span className="font-mono text-sm">
                        {formatUsd(g.costUsd)}
                        {g.costEstimated ? <span className="ml-1 font-sans text-xs text-muted">estimated</span> : null}
                      </span>
                    </div>
                    <Meter budget={g.budgetTokens} used={g.usedTokens} />
                    {top.length > 0 ? (
                      <ul aria-label="Most expensive cards" className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs">
                        {top.map((c) => (
                          <li className="flex gap-2" key={c.id}>
                            <span className="min-w-0 flex-1 truncate">{c.title}</span>
                            <span className="text-muted">{casteLabel(c.caste)}</span>
                            <span className="text-muted">{c.attempts > 1 ? `${c.attempts} tries` : '1 try'}</span>
                            <span className="font-mono">{formatTokens(c.tokens)}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section
          aside={
            <Button aria-pressed={table} onClick={() => setTable((t) => !t)} size="sm" type="button" variant="ghost">
              <Table2 aria-hidden="true" className="size-4" /> {table ? 'Show charts' : 'Show as table'}
            </Button>
          }
          icon={Coins}
          testId="budget-days"
          title="Last 14 days"
        >
          {!hasDays ? (
            <p className="m-0 text-sm text-muted">Nothing spent in the last 14 days.</p>
          ) : table ? (
            <DaysTable days={b.days} />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <DayBars days={b.days} format={(n) => `${formatTokens(n)} tokens`} label="Tokens per day" value={(d) => d.tokens} />
              <DayBars days={b.days} format={formatUsd} label="Cost per day" value={(d) => d.costUsd} />
            </div>
          )}
        </Section>

        <Section icon={Users} testId="budget-roles" title="By role, last 14 days">
          {b.byRole.length === 0 ? (
            <p className="m-0 text-sm text-muted">No runs yet.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {[...b.byRole]
                .sort((x, y) => y.tokens - x.tokens)
                .map((r) => (
                  <li className="grid grid-cols-[7rem_1fr_auto] items-center gap-2 text-sm" data-role={r.role} key={r.role}>
                    <span className="truncate">{roleName(r.role)}</span>
                    <span aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-surface-2">
                      <span className="block h-full rounded-full bg-chart" style={{ width: `${(r.tokens / maxRole) * 100}%` }} />
                    </span>
                    <span className="text-right text-xs text-muted">
                      {formatTokens(r.tokens)} tokens · {formatUsd(r.costUsd)} · {r.runs} run{r.runs === 1 ? '' : 's'}
                      {r.passRate !== null ? ` · ${pct(r.passRate)} passed` : ''}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </Section>

        <Section icon={Coins} testId="budget-subscriptions" title="Subscriptions">
          <Subscriptions engines={snapshot?.engines ?? []} />
          <p className="m-0 text-xs text-muted">Limits and usage windows are set per engine in Connections.</p>
        </Section>
      </div>

      <Section icon={Route} testId="budget-routing" title="How the Treasurer routed each run">
        {b.routing.length === 0 ? (
          <p className="m-0 text-sm text-muted">No runs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-xs">
              <caption className="sr-only">Routing history, newest first</caption>
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1.5 pr-2 font-medium">When</th>
                  <th className="py-1.5 pr-2 font-medium">Who</th>
                  <th className="py-1.5 pr-2 font-medium">Card</th>
                  <th className="py-1.5 pr-2 font-medium">Engine · model · effort</th>
                  <th className="py-1.5 pr-2 font-medium">Why</th>
                  <th className="py-1.5 pr-2 font-medium">Outcome</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Tokens</th>
                  <th className="py-1.5 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {b.routing.map((r) => {
                  const o = OUTCOME[r.outcome];
                  const OIcon = o.icon;
                  return (
                    <tr className="border-t border-line align-top" data-outcome={r.outcome} data-testid="routing-row" key={r.runId}>
                      <td className="whitespace-nowrap py-1.5 pr-2 text-muted">{time(r.at)}</td>
                      <td className="py-1.5 pr-2">{r.caste ? casteLabel(r.caste) : roleName(r.role)}</td>
                      <td className="max-w-[220px] truncate py-1.5 pr-2" title={r.title}>
                        {r.title}
                      </td>
                      <td className="py-1.5 pr-2">
                        {[engineName(r.engine) ?? r.engine ?? '—', r.model ?? '—', r.effort].filter(Boolean).join(' · ')}
                      </td>
                      <td className="py-1.5 pr-2 text-muted">{r.rule}</td>
                      <td className="py-1.5 pr-2">
                        <span className="inline-flex items-center gap-1">
                          <OIcon aria-hidden="true" className={cn('size-3.5', o.className)} />
                          {o.label}
                        </span>
                      </td>
                      <td className="py-1.5 pr-2 text-right font-mono">{formatTokens(r.tokens)}</td>
                      <td className="py-1.5 text-right font-mono">{formatUsd(r.costUsd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section icon={GraduationCap} testId="budget-learned" title="What the Treasurer has learned">
        <p className="m-0 text-xs text-muted">
          For each role, how often each model tier was tried and passed. The Treasurer leans towards what has worked, and still tries the
          others now and then.
        </p>
        {b.learned.length === 0 ? (
          <p className="m-0 text-sm text-muted">Nothing learned yet: it learns from runs that the Inspector passes or fails.</p>
        ) : (
          <table className="w-full border-collapse text-xs">
            <caption className="sr-only">Tries and passes per role and tier</caption>
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1.5 pr-2 font-medium">Role</th>
                <th className="py-1.5 pr-2 font-medium">Engine</th>
                <th className="py-1.5 pr-2 font-medium">Tier</th>
                <th className="py-1.5 pr-2 text-right font-medium">Tries</th>
                <th className="py-1.5 pr-2 text-right font-medium">Passed</th>
                <th className="py-1.5 text-right font-medium">Pass rate</th>
              </tr>
            </thead>
            <tbody>
              {b.learned.map((l) => (
                <tr className="border-t border-line" data-testid="learned-row" key={`${l.role}-${l.engine}-${l.tier}`}>
                  <td className="py-1.5 pr-2">{roleName(l.role)}</td>
                  <td className="py-1.5 pr-2">{engineName(l.engine) ?? l.engine}</td>
                  <td className="py-1.5 pr-2">{l.tier}</td>
                  <td className="py-1.5 pr-2 text-right font-mono">{l.tries}</td>
                  <td className="py-1.5 pr-2 text-right font-mono">{l.passes}</td>
                  <td className="py-1.5 text-right font-mono">{l.tries > 0 ? pct(l.passes / l.tries) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
