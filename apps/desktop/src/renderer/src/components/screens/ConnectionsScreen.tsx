import type { EngineCard, EngineId } from '@insectoids/shared';
import { RefreshCw } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { EngineCardView } from '@/components/connections/EngineCardView';
import { defaultEngine } from '@/components/connections/engine-names';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { refresh, runCommand, useHive } from '@/lib/hive-store';
import { cn } from '@/lib/utils';

type TabId = 'engines' | 'providers' | 'services' | 'vault';

const TABS: Array<{ id: TabId; label: string; later?: { when: string; what: string } }> = [
  { id: 'engines', label: 'Engines' },
  {
    id: 'providers',
    label: 'API providers',
    later: { when: 'Phase 2 · step A4', what: 'Any OpenAI-compatible endpoint (OpenRouter, FreeLLMAPI, Ollama, LM Studio), with keys kept in the Vault.' },
  },
  {
    id: 'services',
    label: 'Services',
    later: { when: 'Phase 2 · step A3', what: 'GitHub and web search for the hive, reached only through the local secret broker. Read-only tools stay on; anything else waits for your OK.' },
  },
  {
    id: 'vault',
    label: 'Vault',
    later: { when: 'Phase 2 · step A3', what: 'Keys encrypted by your operating system. Agents get short-lived, card-scoped access through the broker and never see a key.' },
  },
];

/**
 * Connections (function 04; prototype Connections.dc.html). Phase 2 · A1: the Engines tab is live;
 * the other tabs say what arrives and when. Every change goes through a hive command.
 */
export function ConnectionsScreen() {
  const { snapshot, error: loadError, loading } = useHive();
  const [tab, setTab] = useState<TabId>('engines');
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

  const onTabKey = (ev: KeyboardEvent<HTMLButtonElement>, i: number): void => {
    const next = ev.key === 'ArrowRight' ? i + 1 : ev.key === 'ArrowLeft' ? i - 1 : ev.key === 'Home' ? 0 : ev.key === 'End' ? TABS.length - 1 : null;
    if (next === null) return;
    ev.preventDefault();
    const t = TABS[(next + TABS.length) % TABS.length]!;
    setTab(t.id);
    document.getElementById(`conn-tab-${t.id}`)?.focus();
  };

  const current = TABS.find((t) => t.id === tab)!;

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-5 p-6">
      <div aria-label="Connections" className="flex flex-wrap gap-2" role="tablist">
        {TABS.map((t, i) => (
          <button
            aria-controls={`conn-panel-${t.id}`}
            aria-selected={tab === t.id}
            className={cn(
              'inline-flex min-h-10 items-center gap-2 rounded-full border px-4 text-sm',
              tab === t.id ? 'border-honey text-honey-text' : 'border-line bg-surface text-text hover:bg-surface-2',
            )}
            id={`conn-tab-${t.id}`}
            key={t.id}
            onClick={() => setTab(t.id)}
            onKeyDown={(ev) => onTabKey(ev, i)}
            role="tab"
            tabIndex={tab === t.id ? 0 : -1}
            type="button"
          >
            {t.label}
            {t.later ? <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">Later</span> : null}
          </button>
        ))}
      </div>

      <section aria-labelledby={`conn-tab-${tab}`} className="flex flex-col gap-4" id={`conn-panel-${tab}`} role="tabpanel">
        {current.later ? (
          <div className="flex flex-col gap-2 rounded-2xl border border-dashed border-line bg-surface p-6" data-testid={`later-${tab}`}>
            <h2 className="m-0 font-display text-lg font-semibold">
              {current.label} <span className="text-sm font-normal text-muted">· Later ({current.later.when})</span>
            </h2>
            <p className="m-0 text-sm text-muted">{current.later.what}</p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <p className="m-0 max-w-[640px] text-sm text-muted">
                AI engines run on your own subscriptions. You sign in with each engine&rsquo;s own login; the hive never sees your passwords
                or login tokens. The first engine that is on and ready is the default.
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

            {snapshot && !def && engines.length ? (
              <InlineAlert
                message="Switch an engine on, or install and sign in to one, and the hive can start working."
                title="No engine is ready"
                tone="waiting"
              />
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
