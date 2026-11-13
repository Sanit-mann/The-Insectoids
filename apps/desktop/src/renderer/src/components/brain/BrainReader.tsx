import { Archive, ArrowDownLeft, ArrowUpRight, Pencil } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BrainRecordView } from '@insectoids/shared';
import { InlineError } from '@/components/changes/CardChanges';
import { HoldButton } from '@/components/kokonutui/hold-button';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { runCommand } from '@/lib/hive-store';
import { cn } from '@/lib/utils';
import { TRUST, kindInfo } from './kinds';
import { RecordEditor } from './RecordEditor';
import { RecordLife } from './RecordLife';

type Load = { state: 'loading' } | { state: 'missing' } | { state: 'error'; message: string } | { state: 'ready'; record: BrainRecordView };

const when = (ms: number): string => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Reader pane: one Brain record with trust, source, versions and links (Memory 01-D10, App 07 Brain).
 * Phase 2 B5: Edit (a new version, confirmed, conflicts shown instead of overwritten; RecordEditor) and
 * hold-to-archive (Kokonut UI `hold-button`). `onChanged` tells the screen around it (graph, dashboard).
 */
export function BrainReader({ id, onOpen, onChanged }: { id: string; onOpen: (id: string) => void; onChanged?: () => void }) {
  const [result, setResult] = useState<{ key: string; load: Load } | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** The record being edited (an id, so opening another record closes the editor). */
  const [editing, setEditing] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const reload = (): void => {
    setAttempt((a) => a + 1);
    onChanged?.();
  };
  const archive = async (recordId: string): Promise<void> => {
    setArchiving(true);
    setArchiveError(null);
    const res = await runCommand({ type: 'archiveRecord', id: recordId });
    setArchiving(false);
    if (!res.ok) setArchiveError(res.error);
    reload();
  };
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
          {r.supersededBy && <span className="rounded-full border border-dashed border-line px-2 leading-5">Replaced</span>}
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

      {editing === r.id ? (
        <RecordEditor
          onCancel={() => {
            setEditing(null);
            reload();
          }}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
          record={r}
        />
      ) : (
        !r.archived && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button data-testid="record-edit" onClick={() => setEditing(r.id)} variant="outline">
                <Pencil aria-hidden="true" /> Edit
              </Button>
              <HoldButton
                aria-label={`Hold to archive ${r.title}`}
                completeLabel="Archived"
                data-testid="record-archive"
                disabled={archiving}
                holdingLabel="Keep holding"
                icon={Archive}
                onHoldComplete={() => void archive(r.id)}
                resetAfter={1500}
                variant="danger"
              >
                Hold to archive
              </HoldButton>
            </div>
            <p className="m-0 text-xs text-muted">Archived records leave search but stay readable here, and you can bring them back.</p>
            {archiveError && <InlineAlert message={archiveError} onDismiss={() => setArchiveError(null)} title="Not archived" tone="error" />}
          </div>
        )
      )}

      <RecordLife onChanged={reload} onOpen={onOpen} record={r} />

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
