/**
 * The Brain's timeline (Memory 01-D13 phase 2; Phase 4 A3): every change to a record, newest first, grouped by
 * day, with who made it, what happened in plain words, and the goal it came from. Filters: shelf, kinds and
 * time (the graph's `useGraphFilters`, `SCOPES`, `DATES`, `KindMark`), change type, who, and words in the title.
 * Pages with "Show older" (the contract's `nextCursor`).
 *
 * Reuses: Kokonut UI `inline-alert` (errors) and `empty-state` (nothing changed), shadcn/ui `button`, lucide
 * icons, `openGoal` (goal links). Custom: the filter rows (same look as GraphFilters) and the day groups.
 */
import {
  Archive,
  ArchiveRestore,
  Bot,
  FilePlus2,
  GitMerge,
  History,
  type LucideIcon,
  Pencil,
  Replace,
  Search,
  Target,
  UserRound,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { BrainChange, BrainTimelineEntry, BrainTimelineRequest, BrainTimelineView } from '@insectoids/shared';
import { WEEK } from '@/components/cadence/cadence-words';
import { EmptyState } from '@/components/kokonutui/empty-state';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { openGoal } from '@/lib/goal-nav';
import { cn } from '@/lib/utils';
import { DATES, KindMark, SCOPES, useGraphFilters } from './GraphFilters';
import { KINDS, kindInfo } from './kinds';
import { ago } from './RecordLife';

const PAGE = 50;
const MAX_PAGE = 200;
const QUERY_DEBOUNCE_MS = 250;
const CHANGED_DEBOUNCE_MS = 600;
const DAY = 24 * 60 * 60_000;

/** Change types as chips, in the order people think of them; each has its own icon (never colour alone). */
export const CHANGES: ReadonlyArray<{ change: BrainChange; label: string; icon: LucideIcon }> = [
  { change: 'create', label: 'Created', icon: FilePlus2 },
  { change: 'update', label: 'Edited', icon: Pencil },
  { change: 'archive', label: 'Archived', icon: Archive },
  { change: 'supersede', label: 'Replaced', icon: Replace },
  { change: 'merge', label: 'Merged', icon: GitMerge },
  { change: 'unarchive', label: 'Brought back', icon: ArchiveRestore },
];
const CHANGE_ICON = Object.fromEntries(CHANGES.map((c) => [c.change, c.icon])) as Record<BrainChange, LucideIcon>;

const pad = (n: number): string => String(n).padStart(2, '0');
const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Today", "Yesterday", "Wednesday" (this week), or "Mon 3 November" (with the year when it isn't this year). */
export function dayWords(at: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const d = new Date(at);
  if (days > 1 && days < 7) return WEEK.find((w) => w.day === d.getDay())!.long;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) });
}

const entryKey = (e: BrainTimelineEntry): string => `${e.recordId}#${e.version}`;
const shelfWords = (shelf: string): string => (shelf === 'global' ? 'Global' : shelf);

interface Page {
  /** The filters this page belongs to. */
  key: string;
  entries: BrainTimelineEntry[];
  nextCursor: BrainTimelineView['nextCursor'];
  actors: string[];
  /** When this page loaded: "Today" and "Yesterday" are counted from here. */
  loadedAt: number;
}

export function TimelineView({ onOpen, openId, refreshKey }: { onOpen: (id: string) => void; openId: string | null; refreshKey: number }) {
  const f = useGraphFilters();
  const [changes, setChanges] = useState<BrainChange[]>([]);
  const [actor, setActor] = useState('');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const req: BrainTimelineRequest = {
    scope: f.scope,
    ...(f.kinds.length ? { kinds: f.kinds } : {}),
    ...(changes.length ? { changes } : {}),
    ...(actor ? { actor } : {}),
    ...(debounced ? { query: debounced } : {}),
    ...(f.req.since !== undefined ? { since: f.req.since } : {}),
  };
  const reqKey = JSON.stringify(req);
  const reqRef = useRef(req);
  useEffect(() => {
    reqRef.current = req;
  });

  // Reload when the hive says something changed (debounced: changes come in bursts) or the reader changed a record.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = window.insectoids.hive.onEvent((e) => {
      if (e.type !== 'changed') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setTick((t) => t + 1), CHANGED_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, []);

  const [page, setPage] = useState<Page | null>(null);
  const [firstError, setFirstError] = useState<{ stamp: string; message: string } | null>(null);
  const [older, setOlder] = useState<{ key: string; state: 'loading' } | { key: string; state: 'error'; message: string } | null>(null);
  const [announce, setAnnounce] = useState('');
  const loadedRef = useRef<{ key: string; count: number }>({ key: '', count: 0 });

  const stamp = `${reqKey}#${tick}#${refreshKey}`;
  useEffect(() => {
    let alive = true;
    // A refresh of the same filters keeps as many entries as were showing (no jump back to page one).
    const keep = loadedRef.current.key === reqKey ? Math.min(MAX_PAGE, Math.max(PAGE, loadedRef.current.count)) : PAGE;
    window.insectoids.hive
      .brainTimeline({ ...reqRef.current, limit: keep })
      .then((v) => {
        if (!alive) return;
        loadedRef.current = { key: reqKey, count: v.entries.length };
        setPage({ key: reqKey, entries: v.entries, nextCursor: v.nextCursor, actors: v.actors, loadedAt: Date.now() });
        setFirstError(null);
      })
      .catch((err: unknown) => alive && setFirstError({ stamp, message: err instanceof Error ? err.message : String(err) }));
    return () => {
      alive = false;
    };
  }, [stamp, reqKey]);

  const current = page?.key === reqKey ? page : null;
  const error = firstError?.stamp === stamp ? firstError.message : null;
  const olderNow = older?.key === reqKey ? older : null;
  const olderBusy = olderNow?.state === 'loading';

  const loadOlder = (): void => {
    if (!current?.nextCursor || olderBusy) return;
    const key = reqKey;
    setOlder({ key, state: 'loading' });
    window.insectoids.hive
      .brainTimeline({ ...req, before: current.nextCursor, limit: PAGE })
      .then((v) => {
        setPage((p) => {
          if (!p || p.key !== key) return p;
          const seen = new Set(p.entries.map(entryKey));
          const entries = [...p.entries, ...v.entries.filter((e) => !seen.has(entryKey(e)))];
          loadedRef.current = { key, count: entries.length };
          return { ...p, entries, nextCursor: v.nextCursor, actors: v.actors };
        });
        setOlder(null);
        setAnnounce(
          v.entries.length === 0 ? "That's everything." : `${v.entries.length} older ${v.entries.length === 1 ? 'change' : 'changes'} loaded${v.nextCursor ? '' : ". That's everything."}`,
        );
      })
      .catch((err: unknown) => setOlder({ key, state: 'error', message: err instanceof Error ? err.message : String(err) }));
  };

  // Everyone who changed something (kept while a "who" filter narrows the list), so the select never loses options.
  const agents = [...new Set([...(current?.actors ?? page?.actors ?? []), ...(actor && actor !== 'user' && actor !== 'agents' ? [actor] : [])])]
    .filter((a) => a !== 'user')
    .sort((a, b) => a.localeCompare(b));

  const filtered = f.kinds.length > 0 || changes.length > 0 || actor !== '' || debounced !== '' || f.days !== 0;
  const clearFilters = (): void => {
    for (const k of f.kinds) f.toggleKind(k);
    f.pickDays(0);
    setChanges([]);
    setActor('');
    setQuery('');
  };
  const toggleChange = (c: BrainChange): void => setChanges((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));

  return (
    <section aria-label="Brain timeline" className="flex min-w-0 flex-col gap-3" data-testid="brain-timeline">
      <TimelineFilters
        actor={actor}
        agents={agents}
        changes={changes}
        f={f}
        query={query}
        setActor={setActor}
        setQuery={setQuery}
        toggleChange={toggleChange}
      />

      <p aria-live="polite" className="m-0 text-xs text-muted" data-testid="timeline-count">
        {current
          ? current.entries.length === 0
            ? 'No changes'
            : `${current.entries.length} ${current.entries.length === 1 ? 'change' : 'changes'}${current.nextCursor ? ', newest first; older ones below' : ''}`
          : error
            ? ''
            : 'Loading the timeline…'}
      </p>

      {error && (
        <InlineAlert
          actions={[{ label: 'Try again', onClick: () => setTick((t) => t + 1), primary: true }]}
          message={error}
          title="Couldn't load the timeline"
          tone="error"
        />
      )}

      {!current && !error && <Skeleton />}

      {current && current.entries.length === 0 && (
        <div className="rounded-2xl border border-dashed border-line" data-testid="timeline-empty">
          <EmptyState
            description={filtered ? 'Try a wider time range or fewer filters.' : 'Changes appear here as you and the hive add and edit records.'}
            icon={History}
            {...(filtered ? { secondary: { label: 'Clear filters', onClick: clearFilters } } : {})}
            title="Nothing changed in this range."
          />
        </div>
      )}

      {current && current.entries.length > 0 && (
        <>
          <DayGroups entries={current.entries} now={current.loadedAt} onOpen={onOpen} openId={openId} />
          {current.nextCursor ? (
            <Button
              aria-disabled={olderBusy || undefined}
              className="self-start"
              data-testid="timeline-more"
              onClick={loadOlder}
              size="sm"
              variant="outline"
            >
              <History aria-hidden="true" />
              {olderBusy ? 'Loading older changes…' : 'Show older'}
            </Button>
          ) : (
            <p className="m-0 text-sm text-muted" data-testid="timeline-end">
              That&apos;s everything.
            </p>
          )}
          {olderNow?.state === 'error' && (
            <InlineAlert
              actions={[{ label: 'Try again', onClick: loadOlder, primary: true }]}
              message={olderNow.message}
              onDismiss={() => setOlder(null)}
              title="Couldn't load older changes"
              tone="error"
            />
          )}
        </>
      )}
      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
    </section>
  );
}

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the timeline" className="flex flex-col gap-2" data-testid="timeline-loading" role="status">
      <div className="h-4 w-24 animate-pulse rounded bg-surface-2" />
      {[0, 1, 2, 3].map((i) => (
        <div className="h-16 animate-pulse rounded-[10px] border border-line bg-surface" key={i} />
      ))}
    </div>
  );
}

const chip = (on: boolean): string =>
  cn('inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-xs', on ? 'border-honey text-honey-text' : 'border-line text-muted hover:text-text');
const selectCls = 'min-h-10 rounded-[10px] border border-line bg-surface px-2 text-text focus-visible:outline-2 focus-visible:outline-honey';

function TimelineFilters({
  f,
  changes,
  toggleChange,
  actor,
  setActor,
  agents,
  query,
  setQuery,
}: {
  f: ReturnType<typeof useGraphFilters>;
  changes: BrainChange[];
  toggleChange: (c: BrainChange) => void;
  actor: string;
  setActor: (a: string) => void;
  agents: string[];
  query: string;
  setQuery: (q: string) => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div aria-label="Which shelf" className="flex gap-1" role="group">
          {SCOPES.map((s) => (
            <button
              aria-pressed={f.scope === s.id}
              className={cn(
                'min-h-10 rounded-[10px] border px-3 text-sm',
                f.scope === s.id ? 'border-honey bg-active font-medium text-honey-text' : 'border-line text-muted hover:text-text',
              )}
              key={s.id}
              onClick={() => f.setScope(s.id)}
              type="button"
            >
              {s.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-muted">
          <span>When</span>
          <select className={selectCls} data-testid="timeline-date" onChange={(e) => f.pickDays(Number(e.target.value))} value={f.days}>
            {DATES.map((d) => (
              <option key={d.days} value={d.days}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <select aria-label="Who changed it" className={selectCls} data-testid="timeline-who" onChange={(e) => setActor(e.target.value)} value={actor}>
          <option value="">Everyone</option>
          <option value="user">You</option>
          <option value="agents">All agents</option>
          {agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <label className="flex min-h-10 min-w-[200px] flex-1 items-center gap-2 rounded-[10px] border border-line bg-surface px-3 focus-within:border-honey">
          <Search aria-hidden="true" className="size-4 text-muted" />
          <input
            aria-label="Filter by title"
            className="min-w-0 flex-1 border-0 bg-transparent py-2 text-sm text-text outline-none placeholder:text-muted"
            data-testid="timeline-search"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by title"
            type="search"
            value={query}
          />
        </label>
      </div>
      <div aria-label="Filter by change" className="flex flex-wrap gap-1.5" role="group">
        {CHANGES.map(({ change, label, icon: Icon }) => {
          const on = changes.includes(change);
          return (
            <button aria-pressed={on} className={chip(on)} data-change={change} key={change} onClick={() => toggleChange(change)} type="button">
              <Icon aria-hidden="true" className="size-3" />
              {label}
            </button>
          );
        })}
      </div>
      <div aria-label="Filter by kind" className="flex flex-wrap gap-1.5" role="group">
        {KINDS.map(({ kind, label }) => {
          const on = f.kinds.includes(kind);
          return (
            <button aria-pressed={on} className={chip(on)} key={kind} onClick={() => f.toggleKind(kind)} type="button">
              <KindMark kind={kind} size={12} />
              {label}
            </button>
          );
        })}
      </div>
    </>
  );
}

function DayGroups({ entries, now, onOpen, openId }: { entries: BrainTimelineEntry[]; now: number; onOpen: (id: string) => void; openId: string | null }) {
  const groups: Array<{ day: number; label: string; entries: BrainTimelineEntry[] }> = [];
  for (const e of entries) {
    const day = startOfDay(e.changedAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.entries.push(e);
    else groups.push({ day, label: dayWords(e.changedAt, now), entries: [e] });
  }
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <section aria-labelledby={`timeline-day-${g.day}`} className="flex flex-col gap-1" data-testid="timeline-day" key={g.day}>
          <h3 className="m-0 font-display text-sm font-semibold text-muted" id={`timeline-day-${g.day}`}>
            {g.label}
          </h3>
          <ol className="m-0 flex list-none flex-col gap-1 p-0">
            {g.entries.map((e) => (
              <Entry e={e} key={entryKey(e)} now={now} onOpen={onOpen} open={openId === e.recordId} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function Entry({ e, now, onOpen, open }: { e: BrainTimelineEntry; now: number; onOpen: (id: string) => void; open: boolean }) {
  const ChangeIcon = CHANGE_ICON[e.change];
  const WhoIcon = e.actorType === 'user' ? UserRound : Bot;
  return (
    <li
      className={cn('flex items-start gap-3 rounded-[10px] border border-transparent px-3 py-2', open && 'border-line bg-active')}
      data-change={e.change}
      data-record-id={e.recordId}
      data-testid="timeline-entry"
    >
      <time className="w-12 shrink-0 pt-0.5 text-xs tabular-nums text-muted" dateTime={new Date(e.changedAt).toISOString()} title={ago(e.changedAt, now)}>
        {hhmm(e.changedAt)}
      </time>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <span className={cn('inline-flex items-center gap-1 font-medium', e.actorType === 'user' && 'text-honey-text')} data-testid="timeline-who-label">
            <WhoIcon aria-hidden="true" className="size-3.5" />
            {e.actorType === 'user' ? 'You' : e.changedBy}
          </span>
          <span className="inline-flex min-w-0 items-center gap-1" data-testid="timeline-what">
            <ChangeIcon aria-hidden="true" className="size-3.5 shrink-0 text-honey" />
            <span className="break-words">{e.what}</span>
          </span>
        </span>
        <button
          aria-current={open ? 'true' : undefined}
          className="min-h-8 self-start rounded-md text-left text-sm font-medium break-words text-text underline-offset-4 hover:text-honey-text hover:underline focus-visible:outline-2 focus-visible:outline-honey"
          data-testid="timeline-open"
          onClick={() => onOpen(e.recordId)}
          type="button"
        >
          “{e.title}”
          {e.currentTitle && <span className="ml-1.5 text-xs font-normal text-muted">(now: {e.currentTitle})</span>}
        </button>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
          <span className="inline-flex items-center gap-1">
            <KindMark kind={e.kind} size={12} />
            {kindInfo(e.kind).label}
          </span>
          <span aria-hidden="true">·</span>
          <span>{shelfWords(e.shelf)}</span>
          <span aria-hidden="true">·</span>
          <span>version {e.version}</span>
          {e.goalId && (
            <>
              <span aria-hidden="true">·</span>
              <Button className="px-0 text-xs" data-testid="timeline-goal" onClick={() => openGoal(e.goalId!)} size="sm" variant="link">
                <Target aria-hidden="true" className="size-3" />
                Goal: {e.goalTitle ?? 'open it on the Queen screen'}
              </Button>
            </>
          )}
        </span>
      </span>
    </li>
  );
}
