/**
 * Meaning search (Memory 01-E11; Phase 2 B1): the switch, the consent wording and the progress, shown as
 * a strip on the Brain screen and as a block in Settings. The model is downloaded only after the user
 * turns it on, and the consent line (model, size, source) is always on screen next to the button first.
 *
 * Reuses: shadcn `button`, Kokonut UI `inline-alert`, our `Switch`. Custom: the progress bar (a plain
 * <progress>-like meter; no motion when reduced motion is on).
 */
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { MeaningSearch } from '@insectoids/shared';
import { Switch } from '@/components/connections/Switch';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { runCommand, useHive } from '@/lib/hive-store';
import { cn } from '@/lib/utils';

/** Id of the strip's "Turn on" button, so other parts of the screen can move focus to it. */
export const TURN_ON_ID = 'meaning-search-turn-on';

const mb = (n: number): string => `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10} MB`;
const pct = (p: number): number => Math.round(Math.min(1, Math.max(0, p)) * 100);

/**
 * The consent line, always shown before "Turn on". "off" doesn't tell whether the model is already on
 * this PC, so it never claims "nothing is downloaded": it states the size and source either way.
 */
export function consentLine(m: MeaningSearch): string {
  if (m.state === 'needs-download') {
    return `Downloads ${m.model}, ${mb(m.sizeMb)}, once, from ${m.source}. Nothing about your Brain leaves this PC.`;
  }
  return `If it isn't on this PC yet, turning it on downloads ${m.model}, ${mb(m.sizeMb)}, once, from ${m.source}. Nothing about your Brain leaves this PC.`;
}

const isOn = (s: MeaningSearch['state']): boolean => s === 'downloading' || s === 'indexing' || s === 'ready';

function Meter({ value, label }: { value: number; label: string }) {
  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={pct(value)}
      className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
      role="progressbar"
    >
      <div className="h-full rounded-full bg-honey transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${pct(value)}%` }} />
    </div>
  );
}

function useToggle() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    const r = await runCommand({ type: 'setMeaningSearch', enabled });
    setBusy(false);
    if (!r.ok) setError(r.error);
  };
  return { busy, error, clearError: () => setError(null), set };
}

/** The live status line, in words (status is never colour alone). */
function statusText(m: MeaningSearch): string {
  switch (m.state) {
    case 'downloading':
      return `Downloading ${m.model}: ${pct(m.progress)}%`;
    case 'indexing':
      return `Reading your Brain: ${m.indexed} of ${m.total}`;
    case 'ready':
      return 'Meaning search on';
    case 'error':
      return 'Meaning search stopped';
    default:
      return 'Meaning search off';
  }
}

/** Brain screen strip above the results. */
export function MeaningSearchStrip() {
  const { snapshot } = useHive();
  const toggle = useToggle();
  const m = snapshot?.meaningSearch;
  if (!m) return null;

  if (m.state === 'error') {
    return (
      <div className="flex flex-col gap-2" data-state={m.state} data-testid="meaning-search">
        <InlineAlert
          actions={[{ label: toggle.busy ? 'Trying…' : 'Try again', onClick: () => void toggle.set(true), primary: true }, { label: 'Turn off', onClick: () => void toggle.set(false) }]}
          message={`${m.message} Word search still works.`}
          title="Meaning search stopped"
          tone="error"
        />
        {toggle.error ? <p className="m-0 text-xs text-st-blocked" role="alert">{toggle.error}</p> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-line bg-surface px-3 py-3" data-state={m.state} data-testid="meaning-search">
      {m.state === 'ready' ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-st-done/50 px-2.5 py-1 text-xs font-medium text-text">
            <Sparkles aria-hidden="true" className="size-3.5 text-honey" />
            Meaning search on
          </span>
          <span className="text-xs text-muted">Finds notes with similar meaning, not just the same words.</span>
          <Button className="ml-auto" disabled={toggle.busy} onClick={() => void toggle.set(false)} size="sm" variant="ghost">
            Turn off
          </Button>
        </div>
      ) : isOn(m.state) ? (
        <div aria-live="polite" className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{statusText(m)}</span>
          <Meter label={statusText(m)} value={m.state === 'downloading' ? m.progress : m.total ? m.indexed / m.total : 0} />
          {m.message ? <span className="text-xs text-muted">{m.message}</span> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-start gap-2">
            <Sparkles aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-honey" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-semibold">Search by meaning</span>
              <span className="text-xs text-muted">Finds notes with similar meaning, not just the same words. Runs on this PC.</span>
            </span>
          </div>
          <p className="m-0 text-xs text-muted" data-testid="meaning-consent">
            {consentLine(m)}
          </p>
          <Button disabled={toggle.busy} id={TURN_ON_ID} onClick={() => void toggle.set(true)} size="sm" variant="outline">
            {toggle.busy ? 'Turning on…' : 'Turn on'}
          </Button>
        </div>
      )}
      {toggle.error ? (
        <p className="m-0 text-xs text-st-blocked" role="alert">
          {toggle.error}
        </p>
      ) : null}
    </div>
  );
}

/** Settings block: the same state and switch, with the model's details. */
export function MeaningSearchSettings() {
  const { snapshot } = useHive();
  const toggle = useToggle();
  const m = snapshot?.meaningSearch;
  if (!m) return <p className="m-0 text-sm text-muted">Loading…</p>;
  const on = isOn(m.state);

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4" data-state={m.state} data-testid="meaning-search-settings">
      <div className="flex flex-wrap items-center gap-3">
        <Switch checked={on} disabled={toggle.busy} label="Meaning search" onChange={(next) => void toggle.set(next)} />
        <span className={cn('text-sm', m.state === 'error' ? 'text-st-blocked' : 'text-text')}>{statusText(m)}</span>
      </div>
      {!on ? (
        <p className="m-0 text-xs text-muted" data-testid="meaning-consent">
          {consentLine(m)}
        </p>
      ) : null}
      {m.state === 'downloading' || m.state === 'indexing' ? (
        <Meter label={statusText(m)} value={m.state === 'downloading' ? m.progress : m.total ? m.indexed / m.total : 0} />
      ) : null}
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">Model</dt>
        <dd className="m-0">{m.model}</dd>
        <dt className="text-muted">Size</dt>
        <dd className="m-0 tabular-nums">{mb(m.sizeMb)}</dd>
        <dt className="text-muted">Source</dt>
        <dd className="m-0 break-words">{m.source}</dd>
        <dt className="text-muted">Indexed</dt>
        <dd className="m-0 tabular-nums">
          {m.indexed} of {m.total} records
        </dd>
      </dl>
      {m.message && m.state !== 'error' ? <p className="m-0 text-xs text-muted">{m.message}</p> : null}
      {m.state === 'error' ? <InlineAlert message={`${m.message} Word search still works.`} title="Meaning search stopped" tone="error" /> : null}
      {toggle.error ? <InlineAlert message={toggle.error} onDismiss={toggle.clearError} title="Could not change meaning search" tone="error" /> : null}
    </div>
  );
}

/** How a hit was found, as words (never colour alone). */
export function MatchBadge({ match }: { match: 'words' | 'meaning' | 'both' | undefined }) {
  const m = match ?? 'words';
  const label = m === 'both' ? 'words + meaning' : m;
  return (
    <span
      className={cn(
        'shrink-0 rounded-full border px-1.5 py-px text-[10.5px] font-medium',
        m === 'words' ? 'border-line text-muted' : 'border-honey/50 text-honey-text',
      )}
      data-match={m}
      data-testid="match-badge"
      title={m === 'both' ? 'Found by its words and by meaning' : m === 'meaning' ? 'Found by meaning' : 'Found by its words'}
    >
      {label}
    </span>
  );
}
