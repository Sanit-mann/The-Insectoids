import { CasteSchema, type LibraryItemView, type LibrarySearchResult, type LibraryStatus } from '@insectoids/shared';
import { Download, PencilLine, Search, SearchX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/kokonutui/empty-state';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { casteLabel } from '@/components/hive/format';
import { cn } from '@/lib/utils';
import { StatusBadge } from './StatusBadge';
import { OriginBadge } from './OriginBadge';
import { KIND, STATUS, STATUS_ORDER, usageLine } from './vocab';

const SEARCH_DEBOUNCE_MS = 250;
const PAGE = 50;
type Kind = LibraryItemView['kind'];

interface Filters {
  query: string;
  statuses: LibraryStatus[];
  kinds: Kind[];
  caste: string;
}

const search = (f: Filters, offset: number): Promise<LibrarySearchResult> =>
  window.insectoids.hive.librarySearch({
    query: f.query,
    ...(f.statuses.length ? { statuses: f.statuses } : {}),
    ...(f.kinds.length ? { kinds: f.kinds } : {}),
    ...(f.caste ? { caste: f.caste } : {}),
    limit: PAGE,
    offset,
  });

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; items: LibraryItemView[]; total: number; counts: LibrarySearchResult['counts']; more: 'idle' | 'loading' | 'error' };

/** The library catalog (Capabilities 03-D8): search, filter by status, kind and caste, open an item. */
export function CatalogTab({ selected, onSelect, version }: { selected: string | null; onSelect: (name: string) => void; version: number }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [statuses, setStatuses] = useState<LibraryStatus[]>([]);
  const [kinds, setKinds] = useState<Kind[]>([]);
  const [caste, setCaste] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; load: Load } | null>(null);
  // Reload when the hive changes something (an approval decided elsewhere, a new draft), debounced.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = window.insectoids.hive.onEvent((e) => {
      if (e.type !== 'changed') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setTick((t) => t + 1), 800);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, []);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const importItem = (): void => {
    setImporting(true);
    setImportError(null);
    window.insectoids.hive
      .libraryImport()
      .then((r) => {
        if (r.status === 'error') setImportError(r.message);
        else if (r.status === 'imported') {
          setAttempt((a) => a + 1);
          onSelect(r.name);
        }
      })
      .catch((err: unknown) => setImportError(err instanceof Error ? err.message : String(err)))
      .finally(() => setImporting(false));
  };

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const key = JSON.stringify([debounced, statuses, kinds, caste, attempt, version, tick]);
  const load: Load = result?.key === key ? result.load : { state: 'loading' };
  // Keep the last counts on screen while a new search loads, so the chips don't flicker.
  const [counts, setCounts] = useState<LibrarySearchResult['counts'] | null>(null);

  const filters: Filters = { query: debounced, statuses, kinds, caste };

  useEffect(() => {
    let alive = true;
    search({ query: debounced, statuses, kinds, caste }, 0)
      .then((r) => {
        if (!alive) return;
        setCounts(r.counts);
        setResult({ key, load: { state: 'ready', items: r.items, total: r.total, counts: r.counts, more: 'idle' } });
      })
      .catch((err: unknown) => alive && setResult({ key, load: { state: 'error', message: err instanceof Error ? err.message : String(err) } }));
    return () => {
      alive = false;
    };
  }, [key, debounced, statuses, kinds, caste]);

  const showMore = (): void => {
    if (load.state !== 'ready') return;
    const base = load;
    setResult({ key, load: { ...base, more: 'loading' } });
    search(filters, base.items.length)
      .then((r) => setResult((cur) => (cur?.key === key && cur.load.state === 'ready' ? { key, load: { ...cur.load, items: [...cur.load.items, ...r.items], total: r.total, more: 'idle' } } : cur)))
      .catch(() => setResult((cur) => (cur?.key === key && cur.load.state === 'ready' ? { key, load: { ...cur.load, more: 'error' } } : cur)));
  };

  const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const onlyDrafts = statuses.length === 1 && statuses[0] === 'draft';
  const shownCounts = load.state === 'ready' ? load.counts : counts;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button data-testid="library-import" disabled={importing} onClick={importItem} variant="outline">
          <Download aria-hidden="true" />
          {importing ? 'Importing…' : 'Import a skill or agent'}
        </Button>
        <p className="m-0 min-w-[200px] flex-1 text-xs text-muted">Pick a folder with a SKILL.md or AGENT.md. It is scanned for safety and waits for your OK.</p>
      </div>
      {importError ? <InlineAlert message={importError} onDismiss={() => setImportError(null)} title="Couldn't import it" tone="error" /> : null}
      <label className="flex min-h-10 items-center gap-2 rounded-[10px] border border-line bg-surface px-3 focus-within:border-honey">
        <Search aria-hidden="true" className="size-4 text-muted" />
        <span className="sr-only">Search the library</span>
        <input
          className="min-w-0 flex-1 border-0 bg-transparent py-2 text-text outline-none placeholder:text-muted"
          data-testid="library-search"
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search agents, skills and tools"
          type="search"
          value={query}
        />
      </label>

      <div aria-label="Filter by status" className="flex flex-wrap gap-1.5" role="group">
        {STATUS_ORDER.map((s) => {
          const on = statuses.includes(s);
          const Icon = STATUS[s].icon;
          return (
            <button
              aria-pressed={on}
              className={cn(
                'inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3 text-sm focus-visible:ring-2 focus-visible:ring-honey focus-visible:outline-none',
                on ? 'border-honey bg-active text-honey-text' : 'border-line text-muted hover:text-text',
              )}
              data-status={s}
              data-testid="library-status-filter"
              key={s}
              onClick={() => setStatuses((xs) => toggle(xs, s))}
              title={STATUS[s].explain}
              type="button"
            >
              <Icon aria-hidden="true" className="size-3.5" />
              {STATUS[s].label}
              <span className="tabular-nums text-xs">{shownCounts ? shownCounts[s] : '…'}</span>
            </button>
          );
        })}
      </div>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs text-muted" data-testid="library-status-legend">
        {(statuses.length ? statuses : STATUS_ORDER).map((s) => (
          <li key={s}>
            <span className="font-semibold text-text">{STATUS[s].label}:</span> {STATUS[s].explain}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-1.5">
        <div aria-label="Filter by kind" className="flex flex-wrap gap-1.5" role="group">
          {(Object.keys(KIND) as Kind[]).map((k) => {
            const on = kinds.includes(k);
            return (
              <button
                aria-pressed={on}
                className={cn(
                  'min-h-8 rounded-full border px-3 text-xs focus-visible:ring-2 focus-visible:ring-honey focus-visible:outline-none',
                  on ? 'border-honey text-honey-text' : 'border-line text-muted hover:text-text',
                )}
                key={k}
                onClick={() => setKinds((xs) => toggle(xs, k))}
                type="button"
              >
                {KIND[k].plural}
              </button>
            );
          })}
        </div>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted">
          Caste
          <select
            className="min-h-10 rounded-[10px] border border-line bg-surface px-2 text-sm text-text focus-visible:ring-2 focus-visible:ring-honey focus-visible:outline-none"
            data-testid="library-caste-filter"
            onChange={(e) => setCaste(e.target.value)}
            value={caste}
          >
            <option value="">Any caste</option>
            {CasteSchema.options.map((c) => (
              <option key={c} value={c}>
                {casteLabel(c)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {load.state === 'loading' ? (
        <div aria-busy="true" aria-label="Loading the library" className="flex flex-col gap-2" role="status">
          {[0, 1, 2, 3].map((i) => (
            <div className="h-16 rounded-xl bg-surface-2 motion-safe:animate-pulse" key={i} />
          ))}
        </div>
      ) : null}
      {load.state === 'error' ? (
        <InlineAlert actions={[{ label: 'Try again', onClick: () => setAttempt((a) => a + 1), primary: true }]} message={load.message} title="Couldn't search the library" tone="error" />
      ) : null}

      {load.state === 'ready' && load.items.length === 0 ? (
        onlyDrafts ? (
          <EmptyState
            description="When the hive proposes a skill from repeated work, or you import one, it waits here for your OK."
            icon={PencilLine}
            title="No drafts yet."
          />
        ) : (
          <EmptyState
            description="Try other words, or clear a filter."
            icon={SearchX}
            primary={{
              label: 'Clear the filters',
              onClick: () => {
                setQuery('');
                setStatuses([]);
                setKinds([]);
                setCaste('');
              },
            }}
            title="Nothing in the library matches"
          />
        )
      ) : null}

      {load.state === 'ready' && load.items.length > 0 ? (
        <>
          <p className="m-0 text-xs text-muted" role="status">
            Showing {load.items.length} of {load.total}
          </p>
          <ul aria-label="Library items" className="m-0 flex list-none flex-col gap-1 p-0">
            {load.items.map((it) => {
              const KindIcon = KIND[it.kind].icon;
              const on = selected === it.name;
              return (
                <li key={it.name}>
                  <button
                    aria-current={on ? 'true' : undefined}
                    className={cn(
                      'flex w-full items-start gap-2.5 rounded-[10px] border border-transparent px-3 py-2 text-left hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-honey focus-visible:outline-none',
                      on && 'border-line bg-active',
                    )}
                    data-name={it.name}
                    data-status={it.status}
                    data-testid="library-row"
                    onClick={() => onSelect(it.name)}
                    type="button"
                  >
                    <KindIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-honey" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="truncate font-medium">{it.name}</span>
                        <StatusBadge status={it.status} />
                        <span className="text-xs text-muted">{KIND[it.kind].label}</span>
                        {it.origin !== 'built-in' ? <OriginBadge origin={it.origin} /> : null}
                      </span>
                      <span className="line-clamp-1 text-xs text-muted">{it.description}</span>
                      <span className="text-xs text-muted">
                        {it.castes.length ? it.castes.join(', ') : 'No caste'} · {usageLine(it.usage)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {load.items.length < load.total ? (
            <div className="flex flex-col items-start gap-2">
              <Button data-testid="library-more" disabled={load.more === 'loading'} onClick={showMore} variant="outline">
                {load.more === 'loading' ? 'Loading…' : `Show more (${load.total - load.items.length} left)`}
              </Button>
              {load.more === 'error' ? <p className="m-0 text-xs text-st-blocked">Couldn&rsquo;t load more. Try again.</p> : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
