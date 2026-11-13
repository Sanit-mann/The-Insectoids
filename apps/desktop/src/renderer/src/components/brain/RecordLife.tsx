import { ArchiveRestore, ArrowRight, GitMerge, History } from 'lucide-react';
import { useState } from 'react';
import type { BrainRecordView } from '@insectoids/shared';
import { runCommand } from '@/lib/hive-store';

const day = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });

/** "3 days ago", "just now", … for the usage line. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const units: Array<[number, string]> = [
    [60, 'minute'],
    [60 * 60, 'hour'],
    [60 * 60 * 24, 'day'],
    [60 * 60 * 24 * 30, 'month'],
    [60 * 60 * 24 * 365, 'year'],
  ];
  let pick: [number, string] = units[0]!;
  for (const u of units) if (s >= u[0]) pick = u;
  const n = Math.floor(s / pick[0]);
  return `${n} ${pick[1]}${n === 1 ? '' : 's'} ago`;
}

const times = (n: number): string => (n === 1 ? 'once' : `${n} times`);

/**
 * How a record lives in the Brain (Memory 01-E5, E7, E9; Phase 2 B2): how often agents use it, how
 * important it is, whether it is still current, what it replaced and what was folded into it.
 */
export function RecordLife({ record: r, onOpen, onChanged }: { record: BrainRecordView; onOpen: (id: string) => void; onChanged: () => void }) {
  const u = r.usage;
  const pct = Math.round(Math.min(1, Math.max(0, u.importance)) * 100);
  return (
    <section aria-labelledby="life-title" className="flex flex-col gap-2" data-testid="record-life">
      <h3 id="life-title" className="m-0 font-display text-sm font-semibold">
        Use and status
      </h3>
      <p className="m-0 text-xs" data-testid="usage-line">
        Read {times(u.reads)} · helped {u.helped} · {u.lastUsedAt ? `last used ${ago(u.lastUsedAt)}` : 'not used yet'}
      </p>
      <div className="flex items-center gap-2 text-xs" title="Importance blends how recently the note was used, how often agents read it, and whether it helped work that passed inspection. Important notes rise in search; unused agent notes fade.">
        <span className="text-muted">Importance</span>
        <span
          aria-label={`Importance ${pct} out of 100`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={pct}
          className="relative h-1.5 w-28 overflow-hidden rounded-full bg-line"
          data-testid="importance-meter"
          role="meter"
        >
          <span className="absolute inset-y-0 left-0 rounded-full bg-honey" style={{ width: `${pct}%` }} />
        </span>
        <span className="tabular-nums">{pct}/100</span>
      </div>

      <p className="m-0 flex flex-wrap items-center gap-1.5 text-xs" data-testid="validity">
        {r.supersededBy ? (
          <>
            <History aria-hidden="true" className="size-3.5 text-muted" />
            <span>Replaced on {day(r.validTo ?? r.updatedAt)} by</span>
            <button
              className="min-h-8 rounded-md px-1 font-medium text-honey-text underline-offset-4 hover:underline"
              data-testid="superseded-by"
              onClick={() => onOpen(r.supersededBy!.id)}
              type="button"
            >
              {r.supersededBy.title}
            </button>
          </>
        ) : (
          <span>Current since {day(r.validFrom)}</span>
        )}
      </p>

      {r.supersedes.length > 0 && <RecordLinks icon="replaces" items={r.supersedes} onOpen={onOpen} title="Replaces" />}
      {r.mergedFrom.length > 0 && <RecordLinks icon="merged" items={r.mergedFrom} onOpen={onOpen} title="Merged from" />}

      {r.archived && <ArchivedNote record={r} onRestored={onChanged} />}
    </section>
  );
}

function RecordLinks({ title, items, icon, onOpen }: { title: string; items: Array<{ id: string; title: string }>; icon: 'replaces' | 'merged'; onOpen: (id: string) => void }) {
  const Icon = icon === 'merged' ? GitMerge : ArrowRight;
  return (
    <div className="flex flex-col gap-0.5" data-testid={icon === 'merged' ? 'merged-from' : 'supersedes'}>
      <span className="text-xs text-muted">{title}</span>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {items.map((it) => (
          <li key={it.id}>
            <button className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-surface-2" onClick={() => onOpen(it.id)} type="button">
              <Icon aria-hidden="true" className="size-3.5 text-muted" />
              <span className="min-w-0 flex-1 truncate">{it.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Why a record is in the archive, and "Restore" (B2): bringing a note back is the user's decision only;
 * the hive's `restoreRecord` command runs as the user and keeps the archive step in the history.
 */
function ArchivedNote({ record: r, onRestored }: { record: BrainRecordView; onRestored: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restore = async () => {
    setBusy(true);
    setError(null);
    const result = await runCommand({ type: 'restoreRecord', id: r.id });
    setBusy(false);
    if (result.ok) onRestored();
    else setError(result.error);
  };
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border border-dashed border-line px-3 py-2 text-xs" data-testid="archived-reason">
      <div className="flex flex-wrap items-center gap-2">
        <span>Archived{r.archivedReason ? `: ${r.archivedReason}` : ''}. Kept as history; nothing is deleted.</span>
        <button
          className="inline-flex min-h-10 items-center gap-1.5 rounded-[10px] border border-line px-3 font-semibold text-text hover:bg-surface-2 disabled:cursor-wait disabled:opacity-60"
          disabled={busy}
          onClick={() => void restore()}
          type="button"
        >
          <ArchiveRestore aria-hidden="true" className="size-4" /> {busy ? 'Restoring…' : 'Restore'}
        </button>
      </div>
      {error && (
        <p className="m-0 text-st-blocked" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
