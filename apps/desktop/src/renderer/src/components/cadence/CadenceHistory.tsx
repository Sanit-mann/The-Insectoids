import { type CadenceRunView, type CadenceView, isScheduled } from '@insectoids/shared';
import { History } from 'lucide-react';
import { useEffect, useState } from 'react';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { openGoal } from '@/lib/goal-nav';
import { OUTCOME, REASON, runTime } from './cadence-words';

/** A cadence's run history (Phase 3 A1), newest first, from `hive.cadenceRuns()`. */
export function CadenceHistory({ cadence, now }: { cadence: CadenceView; now: number }) {
  const [runs, setRuns] = useState<CadenceRunView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read again whenever a new run lands (the snapshot's lastRun changes).
  const lastRunId = cadence.lastRun?.id ?? null;

  useEffect(() => {
    let live = true;
    window.insectoids.hive
      .cadenceRuns({ cadenceId: cadence.id, limit: 50 })
      .then((r) => {
        if (live) {
          setRuns(r);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [cadence.id, lastRunId]);

  return (
    <section aria-label={`Runs of ${cadence.name}`} className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4" data-testid="cadence-history">
      <header className="flex items-center gap-2">
        <History aria-hidden="true" className="size-4 text-honey-text" />
        <h2 className="m-0 font-display text-base font-semibold">Runs of "{cadence.name}"</h2>
      </header>
      {error ? <InlineAlert message={error} title="Couldn't read the runs" tone="error" /> : null}
      {runs === null && !error ? <p className="m-0 text-sm text-muted">Reading the runs…</p> : null}
      {runs !== null && runs.length === 0 ? <p className="m-0 text-sm text-muted">
          {isScheduled(cadence.when) ? 'No runs yet. It runs on its schedule, or use Run now.' : 'No runs yet. It runs when it is triggered, or use Run now.'}
        </p> : null}
      {runs !== null && runs.length > 0 ? (
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {runs.map((r) => {
            const o = OUTCOME[r.outcome];
            const Icon = o.icon;
            return (
              <li className="flex flex-col gap-1 rounded-[10px] border border-line bg-ground px-3 py-2" data-outcome={r.outcome} data-testid="cadence-run" key={r.id}>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className={`inline-flex items-center gap-1.5 font-semibold ${o.className}`}>
                    <Icon aria-hidden="true" className="size-4" />
                    {o.label}
                  </span>
                  <span className="text-muted">·</span>
                  <span className="text-text">{REASON[r.reason]}</span>
                  <span className="ml-auto font-mono text-xs text-muted">
                    <time dateTime={new Date(r.at).toISOString()}>{runTime(r.at, now)}</time>
                  </span>
                </div>
                {r.message ? <p className="m-0 text-xs text-muted">{r.message}</p> : null}
                {r.goalId ? (
                  <Button className="self-start" onClick={() => openGoal(r.goalId!)} size="sm" variant="link">
                    Open the goal
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
