import type { EngineCard, EngineUsage as Usage, LaneStatus } from '@insectoids/shared';
import { Gauge } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { formatTokens, formatUsd } from '@/components/hive/format';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { StatusDot } from '@/components/StatusDot';
import { Button } from '@/components/ui/button';
import { runCommand } from '@/lib/hive-store';
import { cn } from '@/lib/utils';

type Window = Usage['window5h'];
type UsageState = Usage['state'];

/** Usage state as colour plus words (App 07: status is never colour-only). */
export const USAGE_DOT: Record<UsageState, LaneStatus> = { ok: 'done', near: 'waiting', exhausted: 'blocked' };
export const USAGE_LABEL: Record<UsageState, string> = { ok: 'Within limits', near: 'Near a limit', exhausted: 'Limit reached' };

const timeOfDay = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dayAndTime = (ms: number): string => {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? timeOfDay(ms) : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
};

/** "≈$0.42 (estimated)" when any run's cost was estimated by the hive. */
function Cost({ w }: { w: Window }) {
  return (
    <span className="tabular-nums">
      {w.costEstimated ? '≈' : ''}
      {formatUsd(w.costUsd)}
      {w.costEstimated ? <span className="ml-1 text-muted">estimated</span> : null}
    </span>
  );
}

function Meter({ label, w, cap, testId }: { label: string; w: Window; cap: number | null; testId: string }) {
  const pct = cap ? Math.min(100, (w.costUsd / cap) * 100) : 0;
  return (
    <div className="flex min-w-0 flex-1 basis-[200px] flex-col gap-1.5" data-testid={testId}>
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-semibold">{label}</span>
        <span className="ml-auto font-mono tabular-nums text-muted">
          {w.runs} {w.runs === 1 ? 'run' : 'runs'} · {formatTokens(w.tokens)} tokens
        </span>
      </div>
      {cap ? (
        <div
          aria-label={`${label}: ${formatUsd(w.costUsd)} of your ${formatUsd(cap)} limit`}
          aria-valuemax={cap}
          aria-valuemin={0}
          aria-valuenow={Math.min(w.costUsd, cap)}
          className="h-1.5 overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
        >
          <div className={cn('h-full', pct >= 100 ? 'bg-st-blocked' : pct >= 80 ? 'bg-st-waiting' : 'bg-honey')} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      <div className="text-xs">
        <Cost w={w} />
        <span className="text-muted">{cap ? ` of ${formatUsd(cap)} limit` : ' · no limit set'}</span>
      </div>
    </div>
  );
}

/** Text field for a USD limit: empty means "no limit". */
function parseCap(raw: string): number | null | 'invalid' {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : 'invalid';
}

/**
 * The Treasurer's view of one engine's subscription (02-D9, 04-D7; Phase 2 A5): hive use in rolling
 * 5-hour and 7-day windows, the user's own soft limits, and "limit reached" when the engine said so.
 */
export function EngineUsageView({ engine: e }: { engine: EngineCard }) {
  const u = e.usage as Usage | undefined;
  const formId = useId();
  const [editing, setEditing] = useState(false);
  const [cap5h, setCap5h] = useState('');
  const [cap7d, setCap7d] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!u) return null;
  const vendorLimit = u.state === 'exhausted' && u.exhaustedUntil !== null;

  const openForm = (): void => {
    setCap5h(u.cap5hUsd ? String(u.cap5hUsd) : '');
    setCap7d(u.cap7dUsd ? String(u.cap7dUsd) : '');
    setError(null);
    setEditing(true);
  };

  const save = async (ev: FormEvent): Promise<void> => {
    ev.preventDefault();
    const a = parseCap(cap5h);
    const b = parseCap(cap7d);
    if (a === 'invalid' || b === 'invalid') {
      setError('Limits are amounts in US dollars above 0, or empty for no limit.');
      return;
    }
    setBusy(true);
    const r = await runCommand({ type: 'setEngineLimits', engineId: e.id, cap5hUsd: a, cap7dUsd: b });
    setBusy(false);
    if (r.ok) setEditing(false);
    else setError(r.error);
  };

  const clearHit = async (): Promise<void> => {
    setBusy(true);
    const r = await runCommand({ type: 'clearEngineLimitHit', engineId: e.id });
    setBusy(false);
    if (!r.ok) setError(r.error);
  };

  return (
    <section aria-label={`${e.name} usage`} className="flex flex-col gap-2.5 rounded-[12px] border border-line bg-ground/40 p-3" data-testid={`engine-${e.id}-usage`}>
      <div className="flex flex-wrap items-center gap-2">
        <Gauge aria-hidden="true" className="size-4 text-muted" />
        <h4 className="m-0 text-sm font-semibold">Usage</h4>
        <span className="ml-auto flex items-center gap-1.5 text-sm" data-state={u.state} data-testid={`engine-${e.id}-usage-state`}>
          <StatusDot status={USAGE_DOT[u.state]} />
          {vendorLimit ? `Limit reached — free again at ${dayAndTime(u.exhaustedUntil!)}` : USAGE_LABEL[u.state]}
        </span>
      </div>

      <div className="flex flex-wrap gap-4">
        <Meter cap={u.cap5hUsd} label="Last 5 hours" testId={`engine-${e.id}-usage-5h`} w={u.window5h} />
        <Meter cap={u.cap7dUsd} label="Last 7 days" testId={`engine-${e.id}-usage-7d`} w={u.window7d} />
      </div>

      {u.state !== 'ok' && u.message ? (
        <p className="m-0 text-xs" data-testid={`engine-${e.id}-usage-message`}>
          {u.message}
        </p>
      ) : null}
      <p className="m-0 text-xs text-muted">
        The hive can't see {e.vendor}'s real quota. It counts its own use here, and stops using this engine when the engine says a limit was hit.
      </p>

      {error ? <InlineAlert message={error} onDismiss={() => setError(null)} title="Couldn't change the limits" tone="error" /> : null}

      {editing ? (
        <form aria-label={`Limits for ${e.name}`} className="flex flex-wrap items-end gap-2" onSubmit={(ev) => void save(ev)}>
          <label className="flex flex-col gap-1 text-xs" htmlFor={`${formId}-5h`}>
            US$ per 5 hours
            <input
              className="min-h-10 w-32 rounded-[10px] border border-line bg-surface px-3 font-mono text-sm tabular-nums"
              id={`${formId}-5h`}
              inputMode="decimal"
              onChange={(ev) => setCap5h(ev.target.value)}
              placeholder="no limit"
              value={cap5h}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs" htmlFor={`${formId}-7d`}>
            US$ per 7 days
            <input
              className="min-h-10 w-32 rounded-[10px] border border-line bg-surface px-3 font-mono text-sm tabular-nums"
              id={`${formId}-7d`}
              inputMode="decimal"
              onChange={(ev) => setCap7d(ev.target.value)}
              placeholder="no limit"
              value={cap7d}
            />
          </label>
          <Button disabled={busy} type="submit">
            Save limits
          </Button>
          <Button disabled={busy} onClick={() => setEditing(false)} type="button" variant="ghost">
            Cancel
          </Button>
          <p className="m-0 w-full text-xs text-muted">Leave a field empty for no limit. At 80% the hive slows down; at 100% it stops using this engine.</p>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy} onClick={openForm} type="button" variant="outline">
            Set limits
          </Button>
          {vendorLimit ? (
            <Button disabled={busy} onClick={() => void clearHit()} type="button" variant="ghost">
              Clear limit
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}
