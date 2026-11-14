import { type KeyboardEvent, useState } from 'react';
import { EnginesPanel } from '@/components/connections/EnginesPanel';
import { ProvidersTab } from '@/components/connections/ProvidersTab';
import { ServicesTab } from '@/components/connections/ServicesTab';
import { VaultTab } from '@/components/connections/VaultTab';
import { cn } from '@/lib/utils';

type TabId = 'engines' | 'providers' | 'services' | 'vault';

const TABS: Array<{ id: TabId; label: string; later?: { when: string; what: string } }> = [
  { id: 'engines', label: 'Engines' },
  { id: 'providers', label: 'API providers' },
  { id: 'services', label: 'Services' },
  { id: 'vault', label: 'Vault' },
];

/**
 * Connections (function 04; prototype Connections.dc.html). Engines (Phase 2 · A1), Services and Vault (A3)
 * and API providers (A4) are live. Engine changes go through hive commands; Services and Vault through the
 * Vault API, and providers through the providers API, both in the main process. The Engines tab is the
 * shared EnginesPanel (also used by the setup wizard, C5).
 */
export function ConnectionsScreen() {
  const [tab, setTab] = useState<TabId>('engines');

  const onTabKey = (ev: KeyboardEvent<HTMLButtonElement>, i: number): void => {
    const next = ev.key === 'ArrowRight' ? i + 1 : ev.key === 'ArrowLeft' ? i - 1 : ev.key === 'Home' ? 0 : ev.key === 'End' ? TABS.length - 1 : null;
    if (next === null) return;
    ev.preventDefault();
    const t = TABS[(next + TABS.length) % TABS.length]!;
    setTab(t.id);
    document.getElementById(`conn-tab-${t.id}`)?.focus();
  };

  const current = TABS.find((t) => t.id === tab)!;
  const openTab = (id: TabId): void => {
    setTab(id);
    requestAnimationFrame(() => document.getElementById(`conn-tab-${id}`)?.focus());
  };

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
        {tab === 'providers' ? (
          <ProvidersTab onOpenEngines={() => openTab('engines')} onOpenVault={() => openTab('vault')} />
        ) : tab === 'services' ? (
          <ServicesTab onOpenVault={() => openTab('vault')} />
        ) : tab === 'vault' ? (
          <VaultTab />
        ) : current.later ? (
          <div className="flex flex-col gap-2 rounded-2xl border border-dashed border-line bg-surface p-6" data-testid={`later-${tab}`}>
            <h2 className="m-0 font-display text-lg font-semibold">
              {current.label} <span className="text-sm font-normal text-muted">· Later ({current.later.when})</span>
            </h2>
            <p className="m-0 text-sm text-muted">{current.later.what}</p>
          </div>
        ) : (
          <EnginesPanel />
        )}
      </section>
    </div>
  );
}
