/**
 * The code map on the Brain screen (Memory 01-E3, D6; Phase 2 B4): a map of the current project's code,
 * made on this PC with tree-sitter (no AI), so agents look code up instead of reading whole files. Here
 * the user can see what is mapped, rebuild it, look up symbols, files and who calls what.
 *
 * Reuses: shadcn `button`, Kokonut UI `inline-alert` (errors), our `StatusDot`. Custom: the status strip,
 * the mode switch (a radio group with arrow keys) and the monospace panels (Cult `code-block` was removed).
 */
import { Code2, FileCode2, FolderOpen, Map as MapIcon, RefreshCw, Search } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type { CodeHit, CodeLookupResult, CodeMapView as CodeMap, LaneStatus } from '@insectoids/shared';
import { StatusDot } from '@/components/StatusDot';
import { openScreen } from '@/components/changes/navigate';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { runCommand, useHive } from '@/lib/hive-store';
import { cn } from '@/lib/utils';
import { ago } from './RecordLife';

export type CodeMode = 'symbol' | 'file' | 'callers' | 'callees';

const LOOKUP_DEBOUNCE_MS = 200;

const MODES: Array<{ id: CodeMode; label: string; placeholder: string }> = [
  { id: 'symbol', label: 'Symbols', placeholder: 'Find a function, class or type by name' },
  { id: 'file', label: 'Files', placeholder: 'Outline of a file, e.g. src/index.ts' },
  { id: 'callers', label: 'Callers', placeholder: 'Who calls this name?' },
  { id: 'callees', label: 'Callees', placeholder: 'What does this name call?' },
];

const STATE: Record<CodeMap['state'], { label: string; dot: LaneStatus }> = {
  off: { label: 'Not built yet', dot: 'idle' },
  building: { label: 'Mapping your code', dot: 'working' },
  ready: { label: 'Ready', dot: 'done' },
  error: { label: 'Could not map', dot: 'blocked' },
};

const LANGUAGE_NAMES: Record<string, string> = {
  typescript: 'TypeScript',
  tsx: 'TSX',
  javascript: 'JavaScript',
  jsx: 'JSX',
  python: 'Python',
  go: 'Go',
  rust: 'Rust',
  java: 'Java',
  'c-sharp': 'C#',
  csharp: 'C#',
  cpp: 'C++',
  ruby: 'Ruby',
  php: 'PHP',
  bash: 'Bash',
  css: 'CSS',
};
const languageName = (l: string): string => LANGUAGE_NAMES[l.toLowerCase()] ?? l.charAt(0).toUpperCase() + l.slice(1);
const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const hitKey = (h: CodeHit): string => `${h.path}:${h.line}:${h.name}`;

type Lookup = { state: 'idle' } | { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; result: CodeLookupResult };

/** One code-map lookup, debounced, keyed so a stale answer never overwrites a newer one. */
function useLookup(query: string, mode: CodeMode, enabled: boolean, debounceMs = LOOKUP_DEBOUNCE_MS): [Lookup, () => void] {
  const [found, setFound] = useState<{ key: string; lookup: Lookup } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const q = query.trim();
  const key = JSON.stringify([q, mode, attempt]);
  let lookup: Lookup = { state: 'idle' };
  if (q && enabled) lookup = found?.key === key ? found.lookup : { state: 'loading' };

  useEffect(() => {
    if (!q || !enabled) return;
    let alive = true;
    const timer = setTimeout(() => {
      window.insectoids.hive
        .codeLookup({ query: q, mode })
        .then((result) => alive && setFound({ key, lookup: { state: 'ready', result } }))
        .catch((err: unknown) => alive && setFound({ key, lookup: { state: 'error', message: err instanceof Error ? err.message : String(err) } }));
    }, debounceMs);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, q, mode, enabled, debounceMs]);

  return [lookup, () => setAttempt((a) => a + 1)];
}

/** The Code view of the Brain screen. */
export function CodeMapView() {
  const { snapshot } = useHive();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<CodeMode>('symbol');
  const [selected, setSelected] = useState<CodeHit | null>(null);
  const map = snapshot?.codeMap;
  const ready = map?.state === 'ready';
  const [lookup, retry] = useLookup(query, mode, ready);

  if (!snapshot) return <div aria-busy="true" className="h-40 w-full animate-pulse rounded-2xl border border-line bg-surface" />;

  if (!snapshot.project) {
    return (
      <div className="flex w-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line p-10 text-center" data-testid="codemap-no-project">
        <FolderOpen aria-hidden="true" className="size-10 text-honey" strokeWidth={1.5} />
        <p className="m-0 max-w-[460px] text-muted">The code map shows your project's functions, files and who calls what. Choose a project for the hive first.</p>
        <Button onClick={() => openScreen('queen')} variant="outline">
          Go to the Queen screen
        </Button>
      </div>
    );
  }

  /** Jump to a name or a file from the detail pane: the search follows. */
  const lookUp = (q: string, m: CodeMode): void => {
    setMode(m);
    setQuery(q);
  };

  return (
    <div className="flex w-full flex-wrap items-start gap-6" data-testid="codemap">
      <section aria-label="Search the code map" className="flex w-full flex-[1_1_320px] flex-col gap-3 md:max-w-[460px]">
        {map && <CodeMapStatus map={map} />}

        <label
          className={cn(
            'flex min-h-10 items-center gap-2 rounded-[10px] border border-line bg-surface px-3 focus-within:border-honey',
            !ready && 'opacity-60',
          )}
        >
          <Search aria-hidden="true" className="size-4 text-muted" />
          <span className="sr-only">Search the code map</span>
          <input
            className="min-w-0 flex-1 border-0 bg-transparent py-2 text-text outline-none placeholder:text-muted disabled:cursor-not-allowed"
            data-testid="codemap-search"
            disabled={!ready}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={ready ? MODES.find((m) => m.id === mode)!.placeholder : 'Search opens once the map is built'}
            type="search"
            value={query}
          />
        </label>
        <ModeSwitch disabled={!ready} mode={mode} onChange={setMode} />

        {ready && <Results lookup={lookup} mode={mode} onRetry={retry} onSelect={setSelected} selected={selected} />}
      </section>

      <div className="min-w-0 flex-[999_1_420px]">
        {selected ? (
          <HitDetail hit={selected} onLookUp={lookUp} onSelect={setSelected} />
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line p-10 text-center text-muted">
            <MapIcon aria-hidden="true" className="size-10 text-honey" strokeWidth={1.5} />
            <p className="m-0 max-w-[420px]">Pick a result to see its file outline, who calls it and what it calls.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** State, counts, languages, last build or progress, and Rebuild (free: plain code, no AI). */
export function CodeMapStatus({ map }: { map: CodeMap }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = STATE[map.state];
  const rebuild = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const r = await runCommand({ type: 'rebuildCodeMap' });
    setBusy(false);
    if (!r.ok) setError(r.error);
  };
  const building = map.state === 'building';
  const pct = map.progress && map.progress.total > 0 ? Math.round((map.progress.done / map.progress.total) * 100) : null;

  return (
    <div className="flex flex-col gap-2.5 rounded-2xl border border-line bg-surface p-4" data-state={map.state} data-testid="codemap-status">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex items-center gap-2 font-display text-[15px] font-semibold">
          <Code2 aria-hidden="true" className="size-4 text-honey" /> Code map
        </span>
        <span className="flex items-center gap-1.5 text-sm" data-testid="codemap-state">
          <StatusDot status={s.dot} /> {s.label}
        </span>
        <Button className="ml-auto" disabled={busy || building} onClick={() => void rebuild()} size="sm" variant="outline">
          <RefreshCw aria-hidden="true" className={cn('size-4', (busy || building) && 'motion-safe:animate-spin')} />
          {busy || building ? 'Rebuilding…' : 'Rebuild'}
        </Button>
      </div>

      <p className="m-0 text-xs text-muted">
        A map of your project's code, made on this PC without AI, so agents look code up instead of reading whole files. Rebuilding is
        free.
      </p>

      {building && map.progress ? (
        <div className="flex flex-col gap-1.5" data-testid="codemap-progress">
          <span className="text-sm tabular-nums">
            Mapping your code: {map.progress.done.toLocaleString()} of {map.progress.total.toLocaleString()}
          </span>
          <div
            aria-label="Mapping progress"
            aria-valuemax={map.progress.total}
            aria-valuemin={0}
            aria-valuenow={map.progress.done}
            className="h-2 overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
          >
            <div className="h-full rounded-full bg-honey motion-safe:transition-[width]" style={{ width: `${pct ?? 0}%` }} />
          </div>
        </div>
      ) : (
        <p className="m-0 flex flex-wrap items-center gap-x-2 text-sm tabular-nums" data-testid="codemap-counts">
          <span>
            {plural(map.files, 'file')} · {plural(map.symbols, 'symbol')}
          </span>
          {map.skipped > 0 && <span className="text-muted">· skipped {map.skipped.toLocaleString()}</span>}
          <span className="text-muted">· {map.lastBuiltAt ? `Last built ${ago(map.lastBuiltAt)}` : 'Never built'}</span>
        </p>
      )}

      {map.languages.length > 0 && (
        <ul aria-label="Languages" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {map.languages.map((l) => (
            <li className="rounded-full border border-line px-2.5 py-0.5 text-xs tabular-nums" key={l.language}>
              {languageName(l.language)} {l.files.toLocaleString()}
            </li>
          ))}
        </ul>
      )}

      {map.message && map.state !== 'error' && <p className="m-0 text-xs text-muted">{map.message}</p>}
      {map.state === 'error' && (
        <InlineAlert
          actions={[{ label: 'Rebuild', onClick: () => void rebuild(), primary: true }]}
          message={map.message}
          title="The code map could not be built"
          tone="error"
        />
      )}
      {error && <InlineAlert message={error} onDismiss={() => setError(null)} title="Rebuild didn't start" tone="error" />}
    </div>
  );
}

/** Symbols / Files / Callers / Callees: a radio group; arrow keys move the choice (App 07 keyboard use). */
function ModeSwitch({ mode, onChange, disabled }: { mode: CodeMode; onChange: (m: CodeMode) => void; disabled: boolean }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = MODES.findIndex((m) => m.id === mode);
    const next = (i + step + MODES.length) % MODES.length;
    onChange(MODES[next]!.id);
    refs.current[next]?.focus();
  };
  return (
    <div aria-label="Look up" className="flex flex-wrap gap-1 rounded-[12px] border border-line bg-surface p-1" onKeyDown={onKeyDown} role="radiogroup">
      {MODES.map((m, i) => {
        const on = m.id === mode;
        return (
          <button
            aria-checked={on}
            className={cn(
              'min-h-9 flex-1 rounded-[9px] px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60',
              on ? 'bg-active text-honey-text' : 'text-muted hover:text-text',
            )}
            disabled={disabled}
            key={m.id}
            onClick={() => onChange(m.id)}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="radio"
            tabIndex={on ? 0 : -1}
            type="button"
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

function Results({
  lookup,
  mode,
  selected,
  onSelect,
  onRetry,
}: {
  lookup: Lookup;
  mode: CodeMode;
  selected: CodeHit | null;
  onSelect: (h: CodeHit) => void;
  onRetry: () => void;
}) {
  if (lookup.state === 'idle') {
    return (
      <p className="m-0 rounded-2xl border border-dashed border-line p-4 text-sm text-muted">
        Type a name or a file path. Symbols finds functions, classes and types; Files shows a file's outline; Callers and Callees follow
        the calls.
      </p>
    );
  }
  if (lookup.state === 'loading') return <div aria-busy="true" className="h-32 animate-pulse rounded-2xl border border-line bg-surface" />;
  if (lookup.state === 'error') {
    return <InlineAlert actions={[{ label: 'Try again', onClick: onRetry, primary: true }]} message={lookup.message} title="Lookup failed" tone="error" />;
  }
  const { result } = lookup;
  if (result.hits.length === 0) {
    return (
      <p className="m-0 text-sm text-muted" data-testid="codemap-empty">
        {result.message || (mode === 'file' ? 'No file in the map matches that path.' : 'Nothing in the map matches that name.')}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {mode === 'file' && result.imports.length > 0 && <Imports imports={result.imports} />}
      <HitList hits={result.hits} label="Code results" onSelect={onSelect} selected={selected} testId="codemap-hit" />
      {result.truncated && (
        <p className="m-0 text-xs text-muted" data-testid="codemap-truncated">
          More matched than shown. Type more of the name or path to narrow it down.
        </p>
      )}
    </div>
  );
}

function HitList({
  hits,
  label,
  selected,
  onSelect,
  testId,
  compact = false,
}: {
  hits: CodeHit[];
  label: string;
  selected: CodeHit | null;
  onSelect: (h: CodeHit) => void;
  testId: string;
  compact?: boolean;
}) {
  return (
    <ul aria-label={label} className="m-0 flex list-none flex-col gap-1 p-0">
      {hits.map((h) => {
        const on = selected !== null && hitKey(selected) === hitKey(h);
        return (
          <li key={hitKey(h)}>
            <button
              aria-current={on ? 'true' : undefined}
              className={cn(
                'flex w-full flex-col gap-1 rounded-[10px] border border-transparent px-3 py-2 text-left hover:bg-surface-2',
                on && 'border-line bg-active',
              )}
              data-testid={testId}
              onClick={() => onSelect(h)}
              type="button"
            >
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <KindBadge kind={h.kind} />
                <span className="truncate font-medium">{h.parent ? `${h.parent}.${h.name}` : h.name}</span>
                <span className="font-mono text-xs text-muted">
                  {h.path}:{h.line}
                </span>
              </span>
              {!compact && (
                <>
                  <code className="block truncate rounded-md bg-surface-2 px-2 py-1 font-mono text-xs text-text">{h.signature}</code>
                  {h.doc && <span className="line-clamp-2 text-xs text-muted">{h.doc}</span>}
                </>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function KindBadge({ kind }: { kind: CodeHit['kind'] }) {
  return (
    <span className="rounded-full border border-line px-2 py-px font-mono text-[11px] text-muted" data-testid="codemap-kind">
      {kind}
    </span>
  );
}

function Imports({ imports }: { imports: string[] }) {
  return (
    <details className="rounded-[10px] border border-line bg-surface px-3 py-2 text-xs" data-testid="codemap-imports">
      <summary className="cursor-pointer select-none font-medium">Imports ({imports.length})</summary>
      <ul className="m-0 mt-1.5 flex list-none flex-col gap-0.5 p-0 font-mono text-muted">
        {imports.map((i) => (
          <li className="truncate" key={i}>
            {i}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** A selected symbol: its declaration, its file's outline, who calls it and what it calls. */
function HitDetail({ hit, onSelect, onLookUp }: { hit: CodeHit; onSelect: (h: CodeHit) => void; onLookUp: (q: string, m: CodeMode) => void }) {
  const [outline, retryOutline] = useLookup(hit.path, 'file', true, 0);
  const [callers, retryCallers] = useLookup(hit.name, 'callers', true, 0);
  const [callees, retryCallees] = useLookup(hit.name, 'callees', true, 0);

  return (
    <article aria-label={`Code: ${hit.name}`} className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5" data-testid="codemap-detail">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <KindBadge kind={hit.kind} />
          <h2 className="m-0 font-display text-lg font-semibold">{hit.parent ? `${hit.parent}.${hit.name}` : hit.name}</h2>
        </div>
        <p className="m-0 font-mono text-xs text-muted">
          {hit.path}:{hit.line}
          {hit.endLine > hit.line ? `–${hit.endLine}` : ''}
        </p>
        <pre className="m-0 overflow-x-auto rounded-[10px] bg-surface-2 px-3 py-2 font-mono text-xs whitespace-pre-wrap" data-testid="codemap-signature">
          {hit.signature}
        </pre>
        {hit.doc && <p className="m-0 text-sm">{hit.doc}</p>}
      </header>

      <DetailList
        empty="No symbols mapped in this file."
        icon={<FileCode2 aria-hidden="true" className="size-4 text-honey" />}
        lookup={outline}
        onMore={() => onLookUp(hit.path, 'file')}
        onRetry={retryOutline}
        onSelect={onSelect}
        selected={hit}
        testId="codemap-outline"
        title={`Outline of ${hit.path}`}
      />
      <DetailList
        empty="Nothing in the map calls this."
        lookup={callers}
        onMore={() => onLookUp(hit.name, 'callers')}
        onRetry={retryCallers}
        onSelect={onSelect}
        selected={hit}
        testId="codemap-callers"
        title="Who calls this"
      />
      <DetailList
        empty="It calls nothing else in the map."
        lookup={callees}
        onMore={() => onLookUp(hit.name, 'callees')}
        onRetry={retryCallees}
        onSelect={onSelect}
        selected={hit}
        testId="codemap-callees"
        title="What it calls"
      />
    </article>
  );
}

function DetailList({
  title,
  icon,
  lookup,
  empty,
  selected,
  onSelect,
  onRetry,
  onMore,
  testId,
}: {
  title: string;
  icon?: ReactNode;
  lookup: Lookup;
  empty: string;
  selected: CodeHit;
  onSelect: (h: CodeHit) => void;
  onRetry: () => void;
  onMore: () => void;
  testId: string;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-1.5" data-testid={testId}>
      <h3 className="m-0 flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </h3>
      {lookup.state === 'loading' && <div aria-busy="true" className="h-16 animate-pulse rounded-[10px] bg-surface-2" />}
      {lookup.state === 'error' && <InlineAlert actions={[{ label: 'Try again', onClick: onRetry }]} message={lookup.message} title="Couldn't load this" tone="error" />}
      {lookup.state === 'ready' && lookup.result.hits.length === 0 && <p className="m-0 text-xs text-muted">{empty}</p>}
      {lookup.state === 'ready' && lookup.result.hits.length > 0 && (
        <>
          <HitList compact hits={lookup.result.hits} label={title} onSelect={onSelect} selected={selected} testId={`${testId}-hit`} />
          {lookup.result.truncated && (
            <button className="min-h-8 self-start text-xs font-medium text-honey-text underline-offset-4 hover:underline" onClick={onMore} type="button">
              Show all in the results list
            </button>
          )}
        </>
      )}
    </section>
  );
}
