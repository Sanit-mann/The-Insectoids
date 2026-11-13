import { BookOpen } from 'lucide-react';
import { type KeyboardEvent, useEffect, useState } from 'react';
import { CastesTab } from '@/components/library/CastesTab';
import { CatalogTab } from '@/components/library/CatalogTab';
import { ItemDetail } from '@/components/library/ItemDetail';
import { clearPendingLibraryItem, onLibraryOpen, peekPendingLibraryItem } from '@/lib/library-nav';
import { cn } from '@/lib/utils';

type TabId = 'castes' | 'catalog';
const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'castes', label: 'Castes' },
  { id: 'catalog', label: 'Catalog' },
];

/**
 * Library (Capabilities 03-D3, D7, D8; Phase 2 C1). Castes: the 8 insect castes, their default skills and
 * network policy. Catalog: every agent, skill and tool, active, ready, dormant or draft, with an item
 * panel. The hive switches skills on per card by itself; here the user imports items, approves drafts
 * (learned or imported, after a safety scan) and retires or restores skills (C3, 03-D5/D6).
 */
export function LibraryScreen() {
  // An item asked for from elsewhere (a card's skill chip) opens straight on the catalog.
  const [opened, setOpened] = useState<string | null>(peekPendingLibraryItem);
  const [tab, setTab] = useState<TabId>(() => (peekPendingLibraryItem() ? 'catalog' : 'castes'));
  /** Bumped after an action in the item panel (approve, retire…), so the catalog list reloads. */
  const [version, setVersion] = useState(0);

  useEffect(() => {
    clearPendingLibraryItem();
    return onLibraryOpen((name) => {
      setOpened(name);
      setTab('catalog');
    });
  }, []);

  const openItem = (name: string): void => {
    setOpened(name);
    setTab('catalog');
  };

  const onTabKey = (ev: KeyboardEvent<HTMLButtonElement>, i: number): void => {
    const next = ev.key === 'ArrowRight' ? i + 1 : ev.key === 'ArrowLeft' ? i - 1 : ev.key === 'Home' ? 0 : ev.key === 'End' ? TABS.length - 1 : null;
    if (next === null) return;
    ev.preventDefault();
    const t = TABS[(next + TABS.length) % TABS.length]!;
    setTab(t.id);
    document.getElementById(`lib-tab-${t.id}`)?.focus();
  };

  return (
    <div className="flex flex-1 flex-col gap-5 p-6" data-testid="library-screen">
      <div className="flex flex-wrap items-center gap-3">
        <div aria-label="Library" className="flex flex-wrap gap-2" role="tablist">
          {TABS.map((t, i) => (
            <button
              aria-controls={`lib-panel-${t.id}`}
              aria-selected={tab === t.id}
              className={cn(
                'inline-flex min-h-10 items-center gap-2 rounded-full border px-4 text-sm focus-visible:ring-2 focus-visible:ring-honey focus-visible:outline-none',
                tab === t.id ? 'border-honey text-honey-text' : 'border-line bg-surface text-text hover:bg-surface-2',
              )}
              data-testid={`library-tab-${t.id}`}
              id={`lib-tab-${t.id}`}
              key={t.id}
              onClick={() => setTab(t.id)}
              onKeyDown={(ev) => onTabKey(ev, i)}
              role="tab"
              tabIndex={tab === t.id ? 0 : -1}
              type="button"
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className="m-0 flex items-center gap-2 text-xs text-muted">
          <BookOpen aria-hidden="true" className="size-4 text-honey" />
          Everything stays dormant until a card needs it; an insect carries at most 5 skills at once.
        </p>
      </div>

      <section aria-labelledby={`lib-tab-${tab}`} id={`lib-panel-${tab}`} role="tabpanel">
        {tab === 'castes' ? (
          <CastesTab onOpenItem={openItem} />
        ) : (
          <div className="flex flex-wrap items-start gap-6">
            <div className="min-w-0 flex-[1_1_360px] md:max-w-[560px]">
              <CatalogTab onSelect={setOpened} selected={opened} version={version} />
            </div>
            <div className="min-w-0 flex-[999_1_380px] md:sticky md:top-4">
              {opened ? (
                <ItemDetail key={opened} name={opened} onChanged={() => setVersion((v) => v + 1)} onClose={() => setOpened(null)} />
              ) : (
                <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line p-10 text-center text-muted">
                  <BookOpen aria-hidden="true" className="text-honey" size={40} strokeWidth={1.5} />
                  <p className="m-0 max-w-[420px]">Pick an item to see what it does, whether the hive may switch it on, where it came from and how it has done.</p>
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
