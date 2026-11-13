import { useRef, useState } from 'react';
import type { ApprovalKind, ApprovalView } from '@insectoids/shared';
import { BookOpen, Inbox } from 'lucide-react';
import { KIND_META, KIND_ORDER, LIBRARY_KINDS, ago, decide } from '@/components/approvals/kinds';
import { Button } from '@/components/ui/button';
import { findLibraryItemForApproval, openLibraryItem } from '@/lib/library-nav';
import { ApprovalCard } from '@/components/kokonutui/ai-tool-approval';
import { EmptyState } from '@/components/kokonutui/empty-state';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { refresh, useHive } from '@/lib/hive-store';
import { cn } from '@/lib/utils';

type Filter = 'all' | ApprovalKind;

function Chip({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        'inline-flex min-h-10 items-center gap-2 rounded-full border px-3.5 text-[13px] transition-colors duration-150',
        active ? 'border-honey/60 bg-active text-honey-text' : 'border-line bg-surface text-muted hover:text-text',
      )}
      onClick={onClick}
      type="button"
    >
      {label}
      <span className={cn('rounded-full px-1.5 text-xs tabular-nums', count > 0 ? 'bg-honey text-honey-ink' : 'bg-surface-2')}>{count}</span>
    </button>
  );
}

/** "Open in the Library" for approvals about a library item (C3). */
function OpenInLibrary({ item, onError }: { item: ApprovalView; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  if (!LIBRARY_KINDS.has(item.kind)) return null;
  const open = (): void => {
    setBusy(true);
    findLibraryItemForApproval(item)
      .then((name) => (name ? openLibraryItem(name) : onError("Couldn't find that item in the Library.")))
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Button className="mt-2 self-start" data-testid="approval-open-library" disabled={busy} onClick={open} size="sm" variant="outline">
      <BookOpen aria-hidden="true" /> Open in the Library
    </Button>
  );
}

function Detail({ item, onError }: { item: ApprovalView; onError: (m: string) => void }) {
  return (
    <div className="flex flex-col">
      <DetailCard item={item} onError={onError} />
      <OpenInLibrary item={item} onError={onError} />
    </div>
  );
}

function DetailCard({ item, onError }: { item: ApprovalView; onError: (m: string) => void }) {
  const meta = KIND_META[item.kind];
  const run = (approve: boolean) => decide(item, approve).catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
  if (item.status === 'waiting') {
    return (
      <ApprovalCard
        destructive={item.destructive}
        from={item.from}
        icon={meta.icon}
        id={item.id}
        ifYouSayYes={item.ifYouSayYes}
        key={item.id}
        kindLabel={meta.label}
        onApprove={() => run(true)}
        onDeny={() => run(false)}
        title={item.title}
        whyItNeedsYou={item.whyItNeedsYou}
      />
    );
  }
  const approved = item.status === 'approved';
  return (
    <section aria-label={item.title} className="rounded-[14px] border border-line bg-surface p-3.5 opacity-80">
      <header className="mb-2.5 flex flex-wrap items-center gap-2">
        <meta.icon aria-hidden="true" className="size-4 text-muted" />
        <h3 className="m-0 text-sm font-semibold">{item.title}</h3>
        <span className="text-xs text-muted">
          {meta.label} · from {item.from}
        </span>
        <span className={cn('ml-auto text-xs font-semibold', approved ? 'text-st-done' : 'text-st-blocked')}>
          {approved ? 'Approved' : 'Denied'}
          {item.decidedAt ? ` ${ago(item.decidedAt)}` : ''}
        </span>
      </header>
      <dl className="m-0 grid gap-2 text-[13px]">
        <div>
          <dt className="text-xs text-muted">Why it needed you</dt>
          <dd className="m-0">{item.whyItNeedsYou}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">If you said yes</dt>
          <dd className="m-0">{item.ifYouSayYes}</dd>
        </div>
      </dl>
    </section>
  );
}

/** Everything the hive is waiting on you for (App 07 approval inbox). */
export function ApprovalsScreen() {
  const { snapshot: snap, error, loading } = useHive();
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  if (!snap) {
    if (loading) {
      return (
        <div aria-busy="true" aria-label="Loading approvals" className="flex flex-col gap-3 p-6">
          {[1, 2, 3].map((i) => (
            <div className="h-14 rounded-[12px] bg-surface-2 motion-safe:animate-pulse" key={i} />
          ))}
        </div>
      );
    }
    return (
      <div className="p-6">
        <InlineAlert actions={[{ label: 'Try again', onClick: () => void refresh(), primary: true }]} message={error ?? ''} title="Can't load approvals" tone="error" />
      </div>
    );
  }

  const waitingCount = (k: Filter) => snap.approvals.filter((a) => a.status === 'waiting' && (k === 'all' || a.kind === k)).length;
  // Pending first (oldest first, so nothing waits forever), then decided (newest first).
  const items = snap.approvals
    .filter((a) => filter === 'all' || a.kind === filter)
    .sort((a, b) => {
      const wa = a.status === 'waiting' ? 0 : 1;
      const wb = b.status === 'waiting' ? 0 : 1;
      if (wa !== wb) return wa - wb;
      return wa === 0 ? a.createdAt - b.createdAt : (b.decidedAt ?? 0) - (a.decidedAt ?? 0);
    });
  const selected = items.find((a) => a.id === selectedId) ?? items[0] ?? null;

  const move = (delta: number) => {
    if (!selected) return;
    const i = items.indexOf(selected);
    const next = items[Math.min(items.length - 1, Math.max(0, i + delta))];
    if (!next) return;
    setSelectedId(next.id);
    listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next.id)}"]`)?.focus();
  };

  return (
    <div className="flex w-full flex-1 flex-col gap-4 p-6">
      <div aria-label="Filter by kind" className="flex flex-wrap gap-2" role="group">
        <Chip active={filter === 'all'} count={waitingCount('all')} label="All" onClick={() => setFilter('all')} />
        {KIND_ORDER.map((k) => (
          <Chip active={filter === k} count={waitingCount(k)} key={k} label={KIND_META[k].plural} onClick={() => setFilter(k)} />
        ))}
      </div>
      {actionError && <InlineAlert message={actionError} onDismiss={() => setActionError(null)} title="That didn't work" tone="error" />}
      {items.length === 0 ? (
        <EmptyState
          description={filter === 'all' ? 'Plans, risky actions and merges show up here when the hive needs your decision.' : `No ${KIND_META[filter].plural.toLowerCase()} right now.`}
          icon={Inbox}
          title="Nothing is waiting for you."
        />
      ) : (
        <div className="flex flex-wrap gap-4">
          <ul
            aria-label="Approvals"
            className="m-0 flex min-w-[260px] flex-[1_1_300px] list-none flex-col gap-1.5 p-0"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                move(e.key === 'ArrowDown' ? 1 : -1);
              }
            }}
            ref={listRef}
          >
            {items.map((a) => {
              const meta = KIND_META[a.kind];
              const isSel = a.id === selected?.id;
              const waiting = a.status === 'waiting';
              return (
                <li key={a.id}>
                  <button
                    aria-current={isSel ? 'true' : undefined}
                    className={cn(
                      'flex min-h-12 w-full items-center gap-3 rounded-[12px] border px-3 py-2 text-left transition-colors duration-150',
                      isSel ? 'border-honey/50 bg-active' : 'border-line bg-surface hover:bg-surface-2',
                      !waiting && 'opacity-60',
                    )}
                    data-id={a.id}
                    onClick={() => setSelectedId(a.id)}
                    tabIndex={isSel ? 0 : -1}
                    type="button"
                  >
                    <meta.icon aria-hidden="true" className="size-4 shrink-0 text-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium">{a.title}</span>
                      <span className="block text-xs text-muted">
                        {meta.label} · {a.from} · {ago(a.createdAt)}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'shrink-0 text-xs font-semibold',
                        waiting ? 'text-st-waiting' : a.status === 'approved' ? 'text-st-done' : 'text-st-blocked',
                      )}
                    >
                      {waiting ? (a.destructive ? 'Hold to approve' : 'Needs you') : a.status === 'approved' ? 'Approved' : 'Denied'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="min-w-[300px] flex-[2_1_420px]">{selected && <Detail item={selected} onError={setActionError} />}</div>
        </div>
      )}
    </div>
  );
}
