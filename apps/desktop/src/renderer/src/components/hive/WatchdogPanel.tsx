import type { IncidentView } from '@insectoids/shared';
import { TriangleAlert, Bug, Clock, CopyX, Hexagon, OctagonX, CirclePause, Repeat, ShieldCheck, Users, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { EmptyState } from '@/components/kokonutui/empty-state';
import { openCard } from '@/lib/open-nav';
import { cn } from '@/lib/utils';

/** Breaker ladder steps in words, with an icon each (never colour alone). */
const STEP: Record<IncidentView['step'], { label: string; icon: LucideIcon; tone: string }> = {
  warn: { label: 'Warned', icon: TriangleAlert, tone: 'border-st-waiting/60' },
  'pause-card': { label: 'Card paused', icon: CirclePause, tone: 'border-st-paused/60' },
  'stop-agent': { label: 'Agent stopped', icon: OctagonX, tone: 'border-st-blocked/60' },
  'pause-hive': { label: 'Hive paused', icon: Hexagon, tone: 'border-st-blocked' },
};

const SENSOR: Record<IncidentView['sensor'], { label: string; icon: LucideIcon }> = {
  loop: { label: 'Repeating itself', icon: Repeat },
  'error-repeat': { label: 'Same error again', icon: CopyX },
  stall: { label: 'No progress', icon: Clock },
  overspend: { label: 'Over budget', icon: Wallet },
  crash: { label: 'Crashed', icon: Bug },
  hive: { label: 'Several agents at once', icon: Users },
};

export const stepLabel = (s: IncidentView['step']): string => STEP[s].label;
export const sensorLabel = (s: IncidentView['sensor']): string => SENSOR[s].label;

export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** The card's short id ("C-02") for display; the board's ids are goal-scoped. */
const shortCard = (id: string): string => id.slice(id.lastIndexOf('.') + 1);

/**
 * Watchdog panel (C2; Hive 02-D9 P3, D12): every incident the Watchdog's code reflexes caught, newest
 * first, with the breaker step it took. Custom list in the app's style; the empty state is Kokonut UI's.
 */
export function WatchdogPanel({ incidents, cardTitle, now }: { incidents: IncidentView[]; cardTitle: (id: string) => string | null; now: number }) {
  return (
    <section aria-labelledby="watchdog-title" className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-4" data-testid="watchdog-panel">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck aria-hidden="true" className="size-4 text-honey" />
        <h2 className="m-0 font-display text-base font-semibold" id="watchdog-title">
          Watchdog
        </h2>
        <span className="text-xs text-muted">{incidents.length === 0 ? 'Nothing caught' : `${incidents.length} incident${incidents.length === 1 ? '' : 's'}`}</span>
      </div>
      <p className="m-0 text-xs text-muted">
        Plain code, no AI: it warns first, then pauses the card, then stops the agent, and pauses the whole hive only when many agents trip at once
        or the Queen herself does.
      </p>
      {incidents.length === 0 ? (
        <EmptyState
          className="py-6"
          description="The Watchdog watches every agent for loops, stalls, crashes and overspending."
          icon={ShieldCheck}
          title="No incidents."
        />
      ) : (
        <ol aria-label="Incidents, newest first" className="m-0 flex list-none flex-col gap-2 p-0">
          {incidents.map((i) => {
            const step = STEP[i.step];
            const sensor = SENSOR[i.sensor];
            const StepIcon = step.icon;
            const SensorIcon = sensor.icon;
            const title = i.cardId ? cardTitle(i.cardId) : null;
            return (
              <li
                className={cn('flex flex-col gap-1 rounded-[10px] border bg-ground px-3 py-2', step.tone)}
                data-sensor={i.sensor}
                data-step={i.step}
                data-testid="incident"
                key={i.id}
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <span className="inline-flex items-center gap-1 font-semibold">
                    <StepIcon aria-hidden="true" className="size-4" />
                    {step.label}
                  </span>
                  <span className="text-muted">·</span>
                  <span className="inline-flex items-center gap-1">
                    <SensorIcon aria-hidden="true" className="size-3.5 text-muted" />
                    {sensor.label}
                  </span>
                  <span className="ml-auto text-xs text-muted">
                    <time dateTime={new Date(i.at).toISOString()}>{ago(i.at, now)}</time>
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
                  <span className="text-text">{i.agentId}</span>
                  {i.cardId ? (
                    <>
                      <span>on</span>
                      <button
                        className="min-h-8 rounded-md px-1 text-left text-honey-text underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-honey focus-visible:outline-none"
                        onClick={() => openCard({ goalId: i.goalId, cardId: i.cardId! })}
                        title="Open the card on the Taskboard"
                        type="button"
                      >
                        {title ? `${shortCard(i.cardId)} · ${title}` : shortCard(i.cardId)}
                      </button>
                    </>
                  ) : null}
                  {i.recurrence > 0 ? <span data-testid="incident-recurrence">· seen {i.recurrence} time{i.recurrence === 1 ? '' : 's'} before</span> : null}
                </div>
                <p className="m-0 break-words text-sm">{i.evidence}</p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
