import { AlertTriangle, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { CardView, ChangesView } from '@insectoids/shared';
import AIDiffReview, { type ReviewFile } from '@/components/kokonutui/ai-diff-review';
import UndoButton from '@/components/kokonutui/undo-button';
import { runCommand } from '@/lib/hive-store';
import { cn } from '@/lib/utils';
import { parseUnifiedDiff } from './parse-diff';
import { cardStatus } from './status';

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; changes: ChangesView };

/** One card: its status, what it changed (diff), and Undo card (App 07 principle 6: undo is always visible). */
export function CardChanges({ card }: { card: CardView }) {
  const [result, setResult] = useState<{ key: string; load: Load } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const st = cardStatus(card);
  // Re-read when the card moves on (new commit), is undone, or the user retries.
  const key = [card.goalId, card.id, card.updatedAt, card.undone, attempt].join('/');
  const load: Load = result?.key === key ? result.load : { state: 'loading' };

  useEffect(() => {
    let alive = true;
    window.insectoids.hive
      .changes({ goalId: card.goalId, cardId: card.id })
      .then((changes) => alive && setResult({ key, load: { state: 'ready', changes } }))
      .catch((err: unknown) => alive && setResult({ key, load: { state: 'error', message: err instanceof Error ? err.message : String(err) } }));
    return () => {
      alive = false;
    };
  }, [key, card.goalId, card.id]);

  const patch = load.state === 'ready' ? load.changes.patch : '';
  const parsed = useMemo(() => parseUnifiedDiff(patch), [patch]);
  const files: ReviewFile[] =
    load.state === 'ready' ? load.changes.files.map((f) => ({ path: f.path, status: f.status, diff: parsed.find((p) => p.path === f.path) })) : [];

  const canUndo = card.status === 'done' && !card.undone;

  return (
    <section aria-labelledby="card-title" className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id="card-title" className="m-0 font-display text-xl font-semibold">
            {card.title}
          </h2>
          <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className={cn('inline-block size-2 rounded-full', st.dot)} />
              <span data-testid="card-status">{st.label}</span>
            </span>
            <span>· Wave {card.wave}</span>
            <span>· {card.caste}</span>
            {card.claimedBy && <span>· {card.claimedBy}</span>}
            {card.undone && (
              <span data-testid="undone-tag" className="rounded-full border border-st-paused/50 px-2 text-st-paused">
                undone
              </span>
            )}
          </span>
        </div>
        <UndoButton
          label="Undo card"
          doneLabel="Card undone"
          icon={Undo2}
          testId="undo-card"
          disabled={!canUndo}
          resetAfter={null}
          onCommit={() => {
            setError(null);
            void runCommand({ type: 'undoCard', goalId: card.goalId, cardId: card.id }).then((r) => {
              if (!r.ok) setError(r.error);
            });
          }}
        />
      </header>
      {!canUndo && !card.undone && (
        <p className="m-0 text-xs text-muted">Undo is available once the Inspector has passed this card and it is merged into the goal.</p>
      )}
      {card.undone && (
        <p className="m-0 text-xs text-muted">
          This card&apos;s changes were reverted on the goal&apos;s branch. The history is kept, so nothing is lost.
        </p>
      )}
      {error && <InlineError message={error} />}

      {load.state === 'loading' && <div aria-busy="true" className="h-24 animate-pulse rounded-2xl border border-line bg-surface" />}
      {load.state === 'error' && <InlineError message={`Could not load the changes: ${load.message}`} onRetry={() => setAttempt((a) => a + 1)} />}
      {load.state === 'ready' && files.length === 0 && (
        <p className="m-0 rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
          {card.status === 'done' || card.status === 'review' ? 'This card did not change any files.' : 'No changes yet. They appear here once the insect commits its work.'}
        </p>
      )}
      {load.state === 'ready' && files.length > 0 && <AIDiffReview files={files} truncated={load.changes.truncated} />}
    </section>
  );
}

export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-[10px] border border-st-blocked/50 bg-st-blocked/10 px-3 py-2 text-sm">
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-st-blocked" />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="shrink-0 rounded-md px-2 text-sm font-semibold text-honey-text hover:underline">
          Retry
        </button>
      )}
    </div>
  );
}
