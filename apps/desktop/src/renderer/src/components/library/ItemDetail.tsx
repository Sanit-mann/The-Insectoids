import type { LibraryItemDetail } from '@insectoids/shared';
import { ChevronDown, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MarkdownText } from './MarkdownText';
import { StatusBadge } from './StatusBadge';
import { KIND, OUTCOME, SAFETY, STATUS, usageLine } from './vocab';

type Load = { state: 'loading' } | { state: 'missing' } | { state: 'error'; message: string } | { state: 'ready'; detail: LibraryItemDetail };

const when = (ms: number): string => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** One library item: what it is, whether the hive may switch it on, where it came from, how it has done. */
export function ItemDetail({ name, onClose }: { name: string; onClose: () => void }) {
  const [result, setResult] = useState<{ key: string; load: Load } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [showText, setShowText] = useState(false);
  const key = `${name}/${attempt}`;
  const load: Load = result?.key === key ? result.load : { state: 'loading' };

  useEffect(() => {
    let alive = true;
    window.insectoids.hive
      .libraryItem(name)
      .then((detail) => alive && setResult({ key, load: detail ? { state: 'ready', detail } : { state: 'missing' } }))
      .catch((err: unknown) => alive && setResult({ key, load: { state: 'error', message: err instanceof Error ? err.message : String(err) } }));
    return () => {
      alive = false;
    };
  }, [key, name]);

  return (
    <aside aria-label="Library item" className="flex min-w-0 flex-col gap-4 rounded-2xl border border-line bg-surface p-5" data-testid="library-detail">
      <div className="flex items-start gap-2">
        <h2 className="m-0 min-w-0 flex-1 break-words font-display text-xl font-semibold">{name}</h2>
        <button
          aria-label="Close item"
          className="flex size-10 shrink-0 items-center justify-center rounded-[10px] text-muted hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-honey focus-visible:outline-none"
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </div>

      {load.state === 'loading' ? <div aria-busy="true" aria-label="Loading the item" className="h-48 rounded-xl bg-surface-2 motion-safe:animate-pulse" role="status" /> : null}
      {load.state === 'error' ? (
        <InlineAlert actions={[{ label: 'Try again', onClick: () => setAttempt((a) => a + 1), primary: true }]} message={load.message} title="Couldn't open this item" tone="error" />
      ) : null}
      {load.state === 'missing' ? <p className="m-0 text-sm text-muted">This item is not in the library any more.</p> : null}

      {load.state === 'ready' ? <Ready detail={load.detail} setShowText={setShowText} showText={showText} /> : null}
    </aside>
  );
}

function Ready({ detail, showText, setShowText }: { detail: LibraryItemDetail; showText: boolean; setShowText: (v: boolean) => void }) {
  const { item, body, recentCards } = detail;
  const kind = KIND[item.kind];
  const KindIcon = kind.icon;
  const vetted = item.safety === 'vetted';
  const SafetyIcon = vetted ? ShieldCheck : ShieldAlert;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1 text-muted">
          <KindIcon aria-hidden="true" className="size-3.5 text-honey" /> {kind.label}
        </span>
        <StatusBadge status={item.status} />
        {item.castes.map((c) => (
          <span className="rounded-full border border-line px-2 leading-5 text-muted" key={c}>
            {c}
          </span>
        ))}
      </div>
      <p className="m-0 text-sm">{item.description}</p>
      <p className="m-0 text-xs text-muted" data-testid="library-status-explain">
        {STATUS[item.status].explain}
      </p>

      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted">Safety</dt>
        <dd className={cn('m-0 inline-flex items-center gap-1.5', vetted ? 'text-text' : 'text-muted')} data-testid="library-safety">
          <SafetyIcon aria-hidden="true" className={cn('size-4 shrink-0', vetted ? 'text-st-done' : 'text-st-waiting')} />
          {SAFETY[item.safety]}
        </dd>
        <dt className="text-muted">Use</dt>
        <dd className="m-0">{usageLine(item.usage)}{item.usage.lastUsedAt ? ` · last ${when(item.usage.lastUsedAt)}` : ''}</dd>
      </dl>

      <section aria-labelledby="lib-sources" className="flex flex-col gap-1">
        <h3 className="m-0 font-display text-sm font-semibold" id="lib-sources">
          Where it came from
        </h3>
        {item.sources.length === 0 ? (
          <p className="m-0 text-xs text-muted">Written for The Insectoids.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs">
            {item.sources.map((s) => (
              <li className="break-all" key={`${s.repo}/${s.path}`}>
                <span className="font-mono">{s.repo}</span> <span className="text-muted">· {s.path}</span>
                <span className="text-muted"> · {s.license ?? 'license not recorded'}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="lib-cards" className="flex flex-col gap-1">
        <h3 className="m-0 font-display text-sm font-semibold" id="lib-cards">
          Recent cards
        </h3>
        {recentCards.length === 0 ? (
          <p className="m-0 text-xs text-muted">No card has used it yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
            {recentCards.map((c) => {
              const o = OUTCOME[c.outcome];
              const Icon = o.icon;
              return (
                <li className="flex items-baseline gap-2" key={`${c.cardId}-${c.at}`}>
                  <span className={cn('inline-flex shrink-0 items-center gap-1 text-xs', o.className)}>
                    <Icon aria-hidden="true" className="size-3.5 self-center" />
                    {o.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  <span className="shrink-0 text-xs text-muted">{when(c.at)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {body ? (
        <section className="flex flex-col gap-2">
          <Button aria-expanded={showText} className="self-start" onClick={() => setShowText(!showText)} size="sm" variant="outline">
            <ChevronDown aria-hidden="true" className={cn('transition-transform', showText && 'rotate-180')} />
            {showText ? 'Hide the full text' : 'Read the full text'}
          </Button>
          {showText ? (
            <div className="max-h-[480px] overflow-auto rounded-[10px] border border-line bg-ground p-3" data-testid="library-text">
              <MarkdownText text={body} />
            </div>
          ) : null}
        </section>
      ) : (
        <p className="m-0 text-xs text-muted">Its text isn&rsquo;t in the library yet: dormant items are only listed until they are rewritten and checked.</p>
      )}
    </>
  );
}
