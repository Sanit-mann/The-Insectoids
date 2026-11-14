import type { EngineCard, EngineId } from '@insectoids/shared';
import { RefreshCw } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { EngineCardView } from '@/components/connections/EngineCardView';
import { defaultEngine } from '@/components/connections/engine-names';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { refresh, runCommand, useHive } from '@/lib/hive-store';
import { cn } from '@/lib/utils';

/**
 * Every AI engine as a card (Connections 04-D2, D6): state in words, sign-in, install with consent,
 * on/off and order. Shared by the Connections Engines tab and the setup wizard's Engines step (Phase 2 C5),
 * so both stay the same. Engine changes go through hive commands.
 */
export function EnginesPanel({ intro, noneReady }: { intro?: ReactNode; noneReady?: ReactNode }) {
  const { snapshot, error: loadError, loading } = useHive();
  const [busy, setBusy] = useState<EngineId | 'all' | null>(null);
  const [errors, setErrors] = useState<Partial<Record<EngineId, string>>>({});
  const [checkError, setCheckError] = useState<string | null>(null);

  const engines: EngineCard[] = snapshot?.engines ?? [];
  const def = defaultEngine(engines);

  const setError = (id: EngineId, msg: string | null): void =>
    setErrors((e) => {
      const next = { ...e };
      if (msg) next[id] = msg;
      else delete next[id];
      return next;
    });

  const toggle = async (e: EngineCard, enabled: boolean): Promise<void> => {
    setBusy(e.id);
    setError(e.id, null);
    const r = await runCommand({ type: 'setEngineEnabled', engineId: e.id, enabled });
    setBusy(null);
    if (!r.ok) setError(e.id, r.error);
  };

  const move = async (e: EngineCard, delta: -1 | 1): Promise<void> => {
    const ids = engines.map((x) => x.id);
    const from = ids.indexOf(e.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to]!, ids[from]!];
    setBusy(e.id);
    setError(e.id, null);
    const r = await runCommand({ type: 'setEngineOrder', order: ids });
    setBusy(null);
    if (!r.ok) {
      setError(e.id, r.error);
      return;
    }
    // Keep keyboard focus on the moved engine's button after the list re-renders.
    requestAnimationFrame(() => {
      const btn = document.getElementById(`engine-${e.id}-${delta < 0 ? 'up' : 'down'}`) as HTMLButtonElement | null;
      (btn && !btn.disabled ? btn : document.getElementById(`engine-${e.id}-${delta < 0 ? 'down' : 'up'}`))?.focus();
    });
  };

  const checkAll = async (): Promise<void> => {
    setBusy('all');
    setCheckError(null);
    const r = await runCommand({ type: 'checkEngine' });
    setBusy(null);
    if (!r.ok) setCheckError(r.error);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <p className="m-0 max-w-[640px] text-sm text-muted">
          {intro ?? (
            <>
              AI engines run on your own subscriptions. You sign in with each engine&rsquo;s own login; the hive never sees your passwords
              or login tokens. The first engine that is on and ready is the default.
            </>
          )}
        </p>
        <Button className="ml-auto" disabled={busy !== null} onClick={() => void checkAll()} type="button" variant="outline">
          <RefreshCw aria-hidden="true" className={cn('size-4', busy === 'all' && 'motion-safe:animate-spin')} />
          {busy === 'all' ? 'Checking…' : 'Check again'}
        </Button>
      </div>

      {checkError ? <InlineAlert message={checkError} onDismiss={() => setCheckError(null)} title="Couldn't check the engines" tone="error" /> : null}
      {loadError && !snapshot ? (
        <InlineAlert actions={[{ label: 'Try again', onClick: () => void refresh(), primary: true }]} message={loadError} title="Couldn't load the engines" tone="error" />
      ) : null}

      {loading && !snapshot ? (
        <div aria-busy="true" aria-label="Loading engines" className="grid gap-4 md:grid-cols-2" role="status">
          {[0, 1].map((i) => (
            <div className="h-48 rounded-2xl bg-surface-2 motion-safe:animate-pulse" key={i} />
          ))}
        </div>
      ) : engines.length ? (
        <ol aria-label="Engines, in order of preference" className="m-0 grid list-none gap-4 p-0 md:grid-cols-2" data-testid="engine-list">
          {engines.map((e, i) => (
            <li key={e.id}>
              <EngineCardView
                busy={busy !== null}
                count={engines.length}
                engine={e}
                error={errors[e.id] ?? null}
                index={i}
                isDefault={def?.id === e.id}
                onDismissError={() => setError(e.id, null)}
                onMove={(d) => void move(e, d)}
                onToggle={(on) => void toggle(e, on)}
              />
            </li>
          ))}
        </ol>
      ) : snapshot ? (
        <p className="m-0 text-sm text-muted">No engines are known yet.</p>
      ) : null}

      {snapshot && !def && engines.length
        ? (noneReady ?? (
            <InlineAlert
              message="Switch an engine on, or install and sign in to one, and the hive can start working."
              title="No engine is ready"
              tone="waiting"
            />
          ))
        : null}
    </>
  );
}
