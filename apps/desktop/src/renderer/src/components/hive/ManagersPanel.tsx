import type { ManagersView } from '@insectoids/shared';
import { CircleArrowUp, ClipboardList, Crown, HardHat, NotebookPen, RotateCcw, Telescope } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Switch } from '@/components/connections/Switch';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { runCommand } from '@/lib/hive-store';
import { openBrainRecord, openCard } from '@/lib/open-nav';
import { cn } from '@/lib/utils';
import { ago } from './WatchdogPanel';

/** The Foreman's decisions in words (C2), with an icon each. */
const ACTION: Record<ManagersView['foremanDecisions'][number]['action'], { label: string; icon: LucideIcon }> = {
  'retry-with-note': { label: 'Retried with a note', icon: RotateCcw },
  'stronger-model': { label: 'Retried on a stronger model', icon: CircleArrowUp },
  'to-queen': { label: 'Sent to the Queen', icon: Crown },
};

const REVIEW_CHOICES = [0, 10, 20, 50] as const;

/**
 * The managers' brain side (C2; Hive 02-D8): the Scout before planning, the periodic review, and the
 * Foreman's decisions on stuck cards. Lives on the Hive screen beside the Watchdog, because it is about
 * how the hive runs. Pieces: the app's Switch, shadcn `button`, Kokonut UI `inline-alert`; the rest custom.
 */
export function ManagersPanel({ managers, now }: { managers: ManagersView; now: number }) {
  const [busy, setBusy] = useState<null | 'scout' | 'every' | 'review'>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (what: 'scout' | 'every' | 'review', cmd: Parameters<typeof runCommand>[0]): Promise<void> => {
    setBusy(what);
    setError(null);
    const r = await runCommand(cmd);
    if (!r.ok) setError(r.error);
    setBusy(null);
  };

  const choices: number[] = REVIEW_CHOICES.includes(managers.reviewEveryCards as (typeof REVIEW_CHOICES)[number])
    ? [...REVIEW_CHOICES]
    : [...REVIEW_CHOICES, managers.reviewEveryCards].sort((a, b) => a - b);

  return (
    <section aria-labelledby="managers-title" className="flex min-w-0 flex-col gap-4 rounded-2xl border border-line bg-surface p-4" data-testid="managers-panel">
      <div className="flex flex-wrap items-center gap-2">
        <HardHat aria-hidden="true" className="size-4 text-honey" />
        <h2 className="m-0 font-display text-base font-semibold" id="managers-title">
          Managers
        </h2>
        <span className="text-xs text-muted">They report to the Queen; only she talks to you.</span>
      </div>

      {/* Scout */}
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Telescope aria-hidden="true" className="size-4 text-muted" />
          <span className="text-sm font-semibold" id="scout-label">
            Survey the code before the Queen plans
          </span>
          <span className="ml-auto" data-testid="scout-switch">
            <Switch
              checked={managers.scoutBeforePlanning}
              disabled={busy === 'scout'}
              label="Survey the code before the Queen plans"
              onChange={(v) => void run('scout', { type: 'setManagers', scoutBeforePlanning: v })}
            />
          </span>
        </div>
        <p className="m-0 text-xs text-muted">
          The Scout reads the code map and tells the Queen what is there, so her plan is built on facts. It uses a little of your AI subscription
          for each goal.
        </p>
      </div>

      {/* Periodic review */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <ClipboardList aria-hidden="true" className="size-4 text-muted" />
          <span className="text-sm font-semibold" id="review-every-label">
            Periodic review
          </span>
          <span className="text-xs text-muted" data-testid="review-next">
            {managers.reviewEveryCards === 0 || managers.cardsUntilReview === null
              ? 'Off'
              : `Next review in ${managers.cardsUntilReview} card${managers.cardsUntilReview === 1 ? '' : 's'}`}
          </span>
        </div>
        <div aria-labelledby="review-every-label" className="flex flex-wrap gap-1.5" data-testid="review-every" role="radiogroup">
          {choices.map((n) => {
            const on = managers.reviewEveryCards === n;
            return (
              <button
                aria-checked={on}
                className={cn(
                  'min-h-10 rounded-full border bg-surface px-3 text-sm focus-visible:ring-2 focus-visible:ring-honey focus-visible:outline-none disabled:opacity-50',
                  on ? 'border-honey text-honey-text' : 'border-line text-text hover:border-honey/60',
                )}
                data-value={n}
                disabled={busy === 'every'}
                key={n}
                onClick={() => (on ? undefined : void run('every', { type: 'setManagers', reviewEveryCards: n }))}
                role="radio"
                type="button"
              >
                {n === 0 ? 'Off' : `Every ${n} finished cards`}
              </button>
            );
          })}
        </div>
        <p className="m-0 text-xs text-muted">
          The Foreman looks back over the finished cards and the Watchdog's incidents, and reports what to change. It uses a little of your AI
          subscription each time.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button data-testid="run-review" disabled={busy === 'review'} onClick={() => void run('review', { type: 'runReview' })} size="sm" variant="outline">
            <ClipboardList aria-hidden="true" />
            {busy === 'review' ? 'Starting the review…' : 'Run a review now'}
          </Button>
        </div>
        <div className="rounded-[10px] border border-line bg-ground p-3" data-testid="last-review">
          {managers.lastReview ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="font-semibold text-text">Last review</span>
                <time dateTime={new Date(managers.lastReview.at).toISOString()}>{ago(managers.lastReview.at, now)}</time>
                {managers.lastReview.recordId ? (
                  <button
                    className="ml-auto inline-flex min-h-8 items-center gap-1 rounded-md px-1 text-honey-text underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-honey focus-visible:outline-none"
                    onClick={() => openBrainRecord(managers.lastReview!.recordId!)}
                    type="button"
                  >
                    <NotebookPen aria-hidden="true" className="size-3.5" />
                    Open in the Brain
                  </button>
                ) : null}
              </div>
              <p className="m-0 mt-1 whitespace-pre-wrap text-sm">{managers.lastReview.summary}</p>
            </>
          ) : (
            <p className="m-0 text-sm text-muted">No review yet.</p>
          )}
        </div>
      </div>

      {/* Foreman decisions */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <HardHat aria-hidden="true" className="size-4 text-muted" />
          <span className="text-sm font-semibold">Foreman's decisions on stuck cards</span>
        </div>
        {managers.foremanDecisions.length === 0 ? (
          <p className="m-0 text-sm text-muted">None yet. When a card runs out of attempts or the Watchdog pauses it, the Foreman decides what happens next.</p>
        ) : (
          <ol aria-label="Foreman's decisions, newest first" className="m-0 flex list-none flex-col gap-1.5 p-0">
            {managers.foremanDecisions.map((d) => {
              const a = ACTION[d.action];
              const Icon = a.icon;
              return (
                <li className="flex flex-col gap-0.5 rounded-[10px] border border-line bg-ground px-3 py-2" data-action={d.action} data-testid="foreman-decision" key={`${d.cardId}-${d.at}`}>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <span className="inline-flex items-center gap-1 font-semibold">
                      <Icon aria-hidden="true" className="size-4" />
                      {a.label}
                    </span>
                    <button
                      className="min-h-8 rounded-md px-1 text-left text-honey-text underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-honey focus-visible:outline-none"
                      onClick={() => openCard({ goalId: d.goalId, cardId: d.cardId })}
                      title="Open the card on the Taskboard"
                      type="button"
                    >
                      {d.cardTitle}
                    </button>
                    <span className="ml-auto text-xs text-muted">
                      <time dateTime={new Date(d.at).toISOString()}>{ago(d.at, now)}</time>
                    </span>
                  </div>
                  <p className="m-0 text-sm text-muted">{d.reason}</p>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {error ? <InlineAlert message={error} onDismiss={() => setError(null)} title="That didn't work" tone="error" /> : null}
    </section>
  );
}
