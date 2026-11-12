import { Archive, ArrowDownLeft, ArrowUpRight, Pencil } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BrainRecordView } from '@insectoids/shared';
import { InlineError } from '@/components/changes/CardChanges';
import { cn } from '@/lib/utils';
import { TRUST, kindInfo } from './kinds';

type Load = { state: 'loading' } | { state: 'missing' } | { state: 'error'; message: string } | { state: 'ready'; record: BrainRecordView };

const when = (ms: number): string => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Reader pane: one Brain record with trust, source, versions and links (Memory 01-D10, App 07 Brain). */
export function BrainReader({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const [result, setResult] = useState<{ key: string; load: Load } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = [id, attempt].join('/');
  const load: Load = result?.key === key ? result.load : { state: 'loading' };

  useEffect(() => {
    let alive = true;
    window.insectoids.hive
      .brainRecord(id)
      .then((record) => alive && setResult({ key, load: record ? { state: 'ready', record } : { state: 'missing' } }))
      .catch((err: unknown) => alive && setResult({ key, load: { state: 'error', message: err instanceof Error ? err.message : String(err) } }));
    return () => {
      alive = false;
    };
  }, [key, id]);

  if (load.state === 'loading') return <div aria-busy="true" className="h-64 animate-pulse rounded-2xl border border-line bg-surface" />;
  if (load.state === 'error') return <InlineError message={`Could not open the record: ${load.message}`} onRetry={() => setAttempt((a) => a + 1)} />;
  if (load.state === 'missing') return <p className="m-0 text-muted">This record is not in the Brain any more.</p>;

  const r = load.record;
  const k = kindInfo(r.kind);
  const t = TRUST[r.trust];
  const Icon = k.icon;

  return (
    <article aria-labelledby="record-title" data-testid="brain-reader" className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5">
      <header className="flex flex-col gap-2">
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="inline-flex items-center gap-1">
            <Icon aria-hidden="true" className="size-3.5 text-honey" /> {k.label}
          </span>
          <span data-testid="trust-badge" title={t.hint} className={cn('rounded-full border px-2 leading-5', t.className)}>
            {t.label}
          </span>
          {r.archived && <span className="rounded-full border border-line px-2 leading-5">Archived</span>}
        </span>
        <h2 id="record-title" className="m-0 font-display text-xl font-semibold">
          {r.title}
        </h2>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-muted">Shelf</dt>
          <dd className="m-0">{r.shelf}</dd>
          <dt className="text-muted">Written by</dt>
          <dd className="m-0">{r.owner}</dd>
          {r.source && (
            <>
              <dt className="text-muted">Source</dt>
              <dd className="m-0 break-all font-mono">{r.source}</dd>
            </>
          )}
          <dt className="text-muted">Version</dt>
          <dd className="m-0">
            {r.version} · updated {when(r.updatedAt)}
          </dd>
        </dl>
      </header>

      {r.summary && <p className="m-0 text-sm text-muted">{r.summary}</p>}
      <div className="whitespace-pre-wrap break-words rounded-[10px] border border-line bg-ground p-3 text-sm">{r.body}</div>

      <div className="flex flex-wrap gap-2">
        {[
          { label: 'Edit', icon: Pencil },
          { label: 'Archive', icon: Archive },
        ].map(({ label, icon: I }) => (
          <span key={label} title={`${label} arrives in Phase 2. Every change will be saved as a new version.`}>
            <button
              type="button"
              disabled
              className="inline-flex min-h-10 cursor-not-allowed items-center gap-2 rounded-[10px] border border-line px-3.5 font-semibold text-muted opacity-60"
            >
              <I aria-hidden="true" className="size-4" /> {label}
            </button>
          </span>
        ))}
      </div>

      <section aria-labelledby="links-title" className="flex flex-col gap-1">
        <h3 id="links-title" className="m-0 font-display text-sm font-semibold">
          Links
        </h3>
        {r.links.length === 0 ? (
          <p className="m-0 text-xs text-muted">No links yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {r.links.map((l) => (
              <li key={`${l.direction}-${l.rel}-${l.id}`}>
                <button type="button" onClick={() => onOpen(l.id)} className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-surface-2">
                  {l.direction === 'out' ? (
                    <ArrowUpRight aria-hidden="true" className="size-3.5 text-muted" />
                  ) : (
                    <ArrowDownLeft aria-hidden="true" className="size-3.5 text-muted" />
                  )}
                  <span className="text-xs text-muted">{l.direction === 'out' ? l.rel : `${l.rel} (from)`}</span>
                  <span className="min-w-0 flex-1 truncate">{l.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="history-title" className="flex flex-col gap-1">
        <h3 id="history-title" className="m-0 font-display text-sm font-semibold">
          Versions
        </h3>
        <ol className="m-0 flex list-none flex-col gap-1 p-0">
          {[...r.history].reverse().map((v) => (
            <li key={v.version} className="flex flex-wrap items-baseline gap-2 text-xs">
              <span className="font-mono text-muted">v{v.version}</span>
              <span>{v.change}</span>
              <span className="text-muted">
                by {v.changedBy} · {when(v.changedAt)} · {TRUST[v.trust].label.toLowerCase()}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}
