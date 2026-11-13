import { Brain, Code2, LayoutDashboard, NotebookText, Network, Search } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type { BrainHitView, RecordKind } from '@insectoids/shared';
import { BrainCareRow } from '@/components/brain/BrainCare';
import { BrainReader } from '@/components/brain/BrainReader';
import { CodeMapView } from '@/components/brain/CodeMapView';
import { DashboardView } from '@/components/brain/DashboardView';
import { GraphView } from '@/components/brain/GraphView';
import { KINDS, kindInfo } from '@/components/brain/kinds';
import { HitStatusBadge } from '@/components/brain/HitStatus';
import { MatchBadge, MeaningSearchStrip, TURN_ON_ID } from '@/components/brain/MeaningSearch';
import { Switch } from '@/components/connections/Switch';
import { InlineError } from '@/components/changes/CardChanges';
import { useHive } from '@/lib/hive-store';
import { clearPendingRecord, onBrainRecordOpen, peekPendingRecord } from '@/lib/open-nav';
import { cn } from '@/lib/utils';

const SEARCH_DEBOUNCE_MS = 250;

type Results = { state: 'idle' } | { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; hits: BrainHitView[] };

/**
 * Brain (App 07, Memory 01-D10): search by words and, once switched on, by meaning (01-E11, Phase 2 B1);
 * filter by kind; read a record with its trust, versions and links. Above them (B3): Brain health, the
 * Librarian and the lessons the hive learned. B5: the graph, the dashboard, and editing in the reader.
 */
type BrainView = 'notes' | 'graph' | 'dashboard' | 'code';
const VIEWS: Array<{ id: BrainView; label: string; icon: typeof Code2 }> = [
  { id: 'notes', label: 'Notes', icon: NotebookText },
  { id: 'graph', label: 'Graph', icon: Network },
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'code', label: 'Code', icon: Code2 },
];

/**
 * Notes | Graph | Dashboard | Code (Phase 2 B4, B5): the Brain's records, the graph of how they link,
 * the numbers and timeline, or the code map of the current project. Arrow keys switch.
 */
function ViewSwitch({ view, onChange }: { view: BrainView; onChange: (v: BrainView) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = VIEWS.findIndex((v) => v.id === view);
    const next = (i + step + VIEWS.length) % VIEWS.length;
    onChange(VIEWS[next]!.id);
    refs.current[next]?.focus();
  };
  return (
    <div aria-label="Brain view" className="flex w-full gap-1.5" data-testid="brain-view-switch" onKeyDown={onKeyDown} role="tablist">
      {VIEWS.map((v, i) => {
        const on = v.id === view;
        const Icon = v.icon;
        return (
          <button
            aria-selected={on}
            className={cn(
              'inline-flex min-h-10 items-center gap-2 rounded-[10px] border px-4 text-sm font-medium',
              on ? 'border-honey bg-active text-honey-text' : 'border-line text-muted hover:text-text',
            )}
            key={v.id}
            onClick={() => onChange(v.id)}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            tabIndex={on ? 0 : -1}
            type="button"
          >
            <Icon aria-hidden="true" className="size-4" />
            {v.label}
          </button>
        );
      })}
    </div>
  );
}

export function BrainScreen() {
  const [view, setView] = useState<BrainView>('notes');
  // C2: another screen (e.g. the last periodic review on the Hive screen) may ask to open a record.
  const [openRequest, setOpenRequest] = useState<{ id: string; n: number } | null>(() => {
    const id = peekPendingRecord();
    return id ? { id, n: 0 } : null;
  });
  useEffect(() => {
    clearPendingRecord();
    return onBrainRecordOpen((id) => {
      setView('notes');
      setOpenRequest((r) => ({ id, n: (r?.n ?? 0) + 1 }));
    });
  }, []);
  if (view === 'code') {
    return (
      <div className="flex flex-1 flex-col gap-6 p-6">
        <ViewSwitch onChange={setView} view={view} />
        <CodeMapView />
      </div>
    );
  }
  if (view === 'graph' || view === 'dashboard') return <WithReader switcher={<ViewSwitch onChange={setView} view={view} />} view={view} />;
  return <NotesView openRequest={openRequest} switcher={<ViewSwitch onChange={setView} view={view} />} />;
}

/** Graph or dashboard on the left, the reader beside it once a record is picked (B5). */
function WithReader({ view, switcher }: { view: 'graph' | 'dashboard'; switcher: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  // Bumped when the reader changes a record, so the graph or the numbers follow at once.
  const [refreshKey, setRefreshKey] = useState(0);
  const changed = (): void => setRefreshKey((k) => k + 1);
  return (
    <div className="flex flex-1 flex-wrap items-start gap-6 p-6">
      {switcher}
      <div className="min-w-0 flex-[999_1_560px]">
        {view === 'graph' ? <GraphView onOpen={setOpenId} openId={openId} refreshKey={refreshKey} /> : <DashboardView onOpen={setOpenId} refreshKey={refreshKey} />}
      </div>
      {openId && (
        <div className="min-w-0 flex-[1_1_380px]">
          <BrainReader id={openId} onChanged={changed} onOpen={setOpenId} />
        </div>
      )}
    </div>
  );
}

/** The Brain's records: search, filters, the reader, and (B3) health, the Librarian and lessons. */
function NotesView({ switcher, openRequest }: { switcher: ReactNode; openRequest: { id: string; n: number } | null }) {
  const { snapshot } = useHive();
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<RecordKind[]>([]);
  /** Also show replaced facts and faded (archived) notes (Phase 2 B2). */
  const [history, setHistory] = useState(false);
  const [found, setFound] = useState<{ key: string; results: Results } | null>(null);
  const [openId, setOpenId] = useState<string | null>(openRequest?.id ?? null);
  // A record opened from another screen while this view is showing (adjusting state during render).
  const [seenRequest, setSeenRequest] = useState(openRequest);
  if (openRequest !== seenRequest) {
    setSeenRequest(openRequest);
    if (openRequest) setOpenId(openRequest.id);
  }
  const [attempt, setAttempt] = useState(0);
  const q = query.trim();
  const key = JSON.stringify([q, kinds, history, attempt]);
  let results: Results = { state: 'idle' };
  if (q) results = found?.key === key ? found.results : { state: 'loading' };

  useEffect(() => {
    if (!q) return;
    let alive = true;
    const timer = setTimeout(() => {
      window.insectoids.hive
        .brainSearch({ query: q, ...(kinds.length ? { kinds } : {}), ...(history ? { includeHistory: true } : {}) })
        .then((hits) => alive && setFound({ key, results: { state: 'ready', hits } }))
        .catch((err: unknown) => alive && setFound({ key, results: { state: 'error', message: err instanceof Error ? err.message : String(err) } }));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, q, kinds, history]);

  const toggleKind = (k: RecordKind): void => setKinds((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]));
  // Honest starting points: the user's own goals, which the hive always records in the Brain.
  const suggestions = (snapshot?.goals ?? []).slice(0, 4).map((g) => g.title);
  const meaningOn = snapshot?.meaningSearch?.state === 'ready';
  // A sentence-like query that finds nothing by words is exactly where meaning search helps.
  const tryMeaning = !meaningOn && snapshot?.meaningSearch !== undefined && q.split(/\s+/).length >= 3;

  return (
    <div className="flex flex-1 flex-wrap items-start gap-6 p-6">
      {switcher}
      <BrainCareRow onOpen={setOpenId} />
      <section aria-label="Search the Brain" className="flex w-full flex-[1_1_300px] flex-col gap-3 md:max-w-[400px]">
        <p className="m-0 text-xs text-muted" data-testid="brain-tidy-intro">
          The Brain keeps itself tidy: notes that get used rise in results, unused agent notes fade into the archive, and nothing is
          ever deleted. Agents never change the notes you confirmed.
        </p>
        <label className="flex min-h-10 items-center gap-2 rounded-[10px] border border-line bg-surface px-3 focus-within:border-honey">
          <Search aria-hidden="true" className="size-4 text-muted" />
          <span className="sr-only">Search the Brain</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={meaningOn ? 'Search the Brain by words or meaning' : 'Search the Brain by words'}
            data-testid="brain-search"
            className="min-w-0 flex-1 border-0 bg-transparent py-2 text-text outline-none placeholder:text-muted"
          />
        </label>
        <MeaningSearchStrip />
        <div className="flex flex-wrap items-center gap-2">
          <Switch checked={history} label="Include history" onChange={setHistory} />
          <span className="text-xs text-muted">Include history: replaced facts and faded notes</span>
        </div>
        <div role="group" aria-label="Filter by kind" className="flex flex-wrap gap-1.5">
          {KINDS.map(({ kind, label }) => {
            const on = kinds.includes(kind);
            return (
              <button
                key={kind}
                type="button"
                aria-pressed={on}
                onClick={() => toggleKind(kind)}
                className={cn('min-h-8 rounded-full border px-3 text-xs', on ? 'border-honey text-honey-text' : 'border-line text-muted hover:text-text')}
              >
                {label}
              </button>
            );
          })}
        </div>

        {results.state === 'idle' && (
          <div className="flex flex-col gap-2 rounded-2xl border border-dashed border-line p-4 text-sm text-muted">
            <p className="m-0">
              Search the Brain for decisions, tasks, facts and outcomes.{' '}
              {meaningOn ? 'Results match your words, their meaning, or both.' : 'Words only until meaning search is on.'}
            </p>
            {suggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {suggestions.map((s) => (
                  <button key={s} type="button" onClick={() => setQuery(s)} className="min-h-8 rounded-full border border-line px-3 text-xs text-text hover:border-honey">
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {results.state === 'loading' && <div aria-busy="true" className="h-32 animate-pulse rounded-2xl border border-line bg-surface" />}
        {results.state === 'error' && <InlineError message={`Search failed: ${results.message}`} onRetry={() => setAttempt((a) => a + 1)} />}
        {results.state === 'ready' && results.hits.length === 0 && (
          <div className="flex flex-col gap-1.5 text-sm text-muted">
            <p className="m-0">{meaningOn ? 'Nothing in the Brain matches those words or their meaning.' : 'Nothing in the Brain matches those words.'}</p>
            {tryMeaning && (
              <p className="m-0" data-testid="try-meaning">
                Try meaning search: it finds notes that say the same thing in other words.{' '}
                <button className="min-h-8 font-medium text-honey-text underline-offset-4 hover:underline" onClick={() => document.getElementById(TURN_ON_ID)?.focus()} type="button">
                  Show me how
                </button>
              </p>
            )}
          </div>
        )}
        {results.state === 'ready' && results.hits.length > 0 && (
          <ul aria-label="Results" className="m-0 flex list-none flex-col gap-1 p-0">
            {results.hits.map((h) => {
              const k = kindInfo(h.kind);
              const Icon = k.icon;
              return (
                <li key={h.id}>
                  <button
                    type="button"
                    data-testid="brain-hit"
                    onClick={() => setOpenId(h.id)}
                    aria-current={openId === h.id ? 'true' : undefined}
                    data-status={h.status}
                    className={cn(
                      'flex w-full items-start gap-2.5 rounded-[10px] border border-transparent px-3 py-2 text-left hover:bg-surface-2',
                      openId === h.id && 'border-line bg-active',
                      // Not current: muted and dashed, plus a text badge (never colour alone).
                      h.status !== 'current' && 'border-dashed border-line opacity-75',
                    )}
                  >
                    <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-honey" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={cn('truncate font-medium', h.status !== 'current' && 'text-muted')}>{h.title}</span>
                        <MatchBadge match={h.match} />
                        <HitStatusBadge status={h.status} />
                      </span>
                      <span className="text-xs text-muted">
                        {k.label}
                        {h.shelf === 'global' ? ' · global' : ''}
                        {h.summary ? ` · ${h.summary}` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="min-w-0 flex-[999_1_420px]">
        {openId ? (
          <BrainReader id={openId} onChanged={() => setAttempt((a) => a + 1)} onOpen={setOpenId} />
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line p-10 text-center text-muted">
            <Brain size={40} strokeWidth={1.5} className="text-honey" aria-hidden="true" />
            <p className="m-0 max-w-[420px]">Pick a result to read it: who wrote it, how much to trust it, its versions and what it links to.</p>
          </div>
        )}
      </div>
    </div>
  );
}
