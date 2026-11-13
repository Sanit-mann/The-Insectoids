/**
 * How the Brain looks after itself (Memory 01-E10, E12; Hive 02 manager "Librarian"; Phase 2 B3):
 * the health score with what makes it up, the Librarian (free audits; an AI review that only suggests),
 * and the lessons the hive learned from failed or retried work.
 *
 * Reuses: shadcn `button`, Kokonut UI `hold-button` (retire a lesson) and `inline-alert` (errors), our
 * `StatusDot`. Custom: the score meter and the lists.
 */
import { Archive, BookOpenCheck, Check, HeartPulse, Library, Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { BrainHealth, HiveCommand, LaneStatus, LessonView, LibrarianView } from '@insectoids/shared';
import { StatusDot } from '@/components/StatusDot';
import { openScreen } from '@/components/changes/navigate';
import { HoldButton } from '@/components/kokonutui/hold-button';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { runCommand, useHive } from '@/lib/hive-store';
import { cn } from '@/lib/utils';
import { TRUST } from './kinds';
import { ago } from './RecordLife';

/** One command at a time per control, with its error shown inline (never thrown away). */
function useCommand() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (cmd: HiveCommand): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const r = await runCommand(cmd);
    setBusy(false);
    if (!r.ok) setError(r.error);
    return r.ok;
  };
  return { busy, error, run, clear: () => setError(null) };
}

function CommandError({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  if (!message) return null;
  return <InlineAlert message={message} onDismiss={onDismiss} title="That didn't work" tone="error" />;
}

/** The word for a score (status is never a number or a colour alone). */
export function healthWord(score: number): { word: string; className: string } {
  if (score >= 80) return { word: 'Tidy', className: 'text-st-done' };
  if (score >= 50) return { word: 'Fair', className: 'text-st-working' };
  return { word: 'Needs care', className: 'text-st-blocked' };
}

const card = 'flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-4';

/** Brain health (01-E12): the score, what makes it up, and a free "Check now". */
export function HealthPanel({ health }: { health: BrainHealth }) {
  const check = useCommand();
  const score = health.score;
  const w = score === null ? null : healthWord(score);
  return (
    <section aria-labelledby="brain-health-title" className={card} data-testid="brain-health">
      <h2 className="m-0 flex items-center gap-2 font-display text-base font-semibold" id="brain-health-title">
        <HeartPulse aria-hidden="true" className="size-4 text-honey" /> Health
      </h2>
      {score === null || w === null ? (
        <p className="m-0 text-sm text-muted" data-testid="health-score">
          Not checked yet.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <p className="m-0 flex items-baseline gap-2" data-testid="health-score">
            <span className="font-display text-4xl font-semibold tabular-nums">{Math.round(score)}</span>
            <span className="text-sm text-muted">/ 100</span>
            <span className={cn('text-sm font-semibold', w.className)}>{w.word}</span>
          </p>
          <div
            aria-label={`Brain health: ${Math.round(score)} of 100, ${w.word}`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(score)}
            className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
            role="meter"
          >
            <div className={cn('h-full rounded-full', score >= 80 ? 'bg-st-done' : score >= 50 ? 'bg-st-working' : 'bg-st-blocked')} style={{ width: `${Math.min(100, Math.max(0, score))}%` }} />
          </div>
        </div>
      )}
      {health.message ? <p className="m-0 text-xs text-muted">{health.message}</p> : null}
      {health.parts.length > 0 && (
        // Folded by default so the search and the reader stay the screen's main parts.
        <details className="group text-[13px]" data-testid="health-details">
          <summary className="flex min-h-10 cursor-pointer select-none items-center text-xs font-medium text-honey-text">
            What makes up the score
          </summary>
        <ul aria-label="What makes up the score" className="m-0 mt-1 flex list-none flex-col gap-1.5 p-0" data-testid="health-parts">
          {health.parts.map((p) => (
            <li className="flex flex-col gap-0.5 text-[13px]" key={p.id}>
              <span className="flex items-baseline gap-2">
                <span className="font-medium">{p.label}</span>
                <span className="tabular-nums text-muted">{p.count}</span>
                <span className={cn('ml-auto tabular-nums text-xs', p.penalty > 0 ? 'text-st-blocked' : 'text-muted')}>
                  {p.penalty > 0 ? `−${Math.round(p.penalty)} points` : 'no cost'}
                </span>
              </span>
              <span className="text-xs text-muted">{p.hint}</span>
            </li>
          ))}
        </ul>
        </details>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted" data-testid="health-checked">
          {health.lastAuditAt ? `Last checked ${ago(health.lastAuditAt)}` : 'Never checked'}
          {health.total ? ` · ${health.total} records` : ''}
        </span>
        <Button className="ml-auto" disabled={check.busy} onClick={() => void check.run({ type: 'runLibrarian', review: false })} size="sm" variant="outline">
          {check.busy ? 'Checking…' : 'Check now'}
        </Button>
      </div>
      <p className="m-0 text-xs text-muted">Checking is free: plain code, no AI.</p>
      <CommandError message={check.error} onDismiss={check.clear} />
    </section>
  );
}

const LIBRARIAN_STATE: Record<LibrarianView['state'], { label: string; status: LaneStatus }> = {
  idle: { label: 'Idle', status: 'idle' },
  auditing: { label: 'Checking the Brain', status: 'working' },
  reviewing: { label: 'Reviewing with AI', status: 'working' },
};

/** The Librarian (memory keeper): free audits by reflex, an AI review that only suggests. */
export function LibrarianCard({ librarian: l }: { librarian: LibrarianView }) {
  const review = useCommand();
  const s = LIBRARIAN_STATE[l.state];
  return (
    <section aria-labelledby="librarian-title" className={card} data-state={l.state} data-testid="librarian">
      <h2 className="m-0 flex items-center gap-2 font-display text-base font-semibold" id="librarian-title">
        <Library aria-hidden="true" className="size-4 text-honey" /> Librarian
      </h2>
      <p className="m-0 flex items-center gap-2 text-sm" data-testid="librarian-state">
        <StatusDot status={s.status} />
        <span>{s.label}</span>
      </p>
      <p className="m-0 text-xs text-muted">
        Tidies the Brain for free. Its AI review only suggests changes; you decide.
      </p>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
        <dt className="text-muted">Last check</dt>
        <dd className="m-0">{l.lastAuditAt ? ago(l.lastAuditAt) : 'Never'}</dd>
        <dt className="text-muted">Last review</dt>
        <dd className="m-0">{l.lastReviewAt ? ago(l.lastReviewAt) : 'Never'}</dd>
        <dt className="text-muted">Next review</dt>
        <dd className="m-0" data-testid="librarian-next">
          {l.nextReview}
        </dd>
      </dl>
      {l.proposalsWaiting > 0 && (
        <button
          className="flex min-h-10 items-center gap-2 rounded-[10px] border border-st-waiting/50 px-3 text-left text-sm hover:bg-surface-2"
          data-testid="librarian-proposals"
          onClick={() => openScreen('approvals')}
          type="button"
        >
          <StatusDot status="waiting" />
          {l.proposalsWaiting} {l.proposalsWaiting === 1 ? 'suggestion waits' : 'suggestions wait'} for you in Approvals
        </button>
      )}
      {l.message ? <p className="m-0 text-xs text-muted">{l.message}</p> : null}
      <div className="flex flex-col gap-1">
        <Button
          disabled={review.busy || l.state !== 'idle'}
          onClick={() => void review.run({ type: 'runLibrarian', review: true })}
          size="sm"
          variant="outline"
        >
          <Sparkles aria-hidden="true" className="size-4" />
          {review.busy ? 'Asking…' : 'Ask the Librarian to review now'}
        </Button>
        <span className="text-xs text-muted" data-testid="librarian-cost">
          Uses a little of your AI subscription.
        </span>
      </div>
      <CommandError message={review.error} onDismiss={review.clear} />
    </section>
  );
}

function LessonItem({ lesson: l, onOpen }: { lesson: LessonView; onOpen: (id: string) => void }) {
  const cmd = useCommand();
  const t = TRUST[l.trust];
  return (
    <li className="flex flex-col gap-1.5 rounded-[10px] border border-line px-3 py-2" data-lesson={l.id} data-testid="lesson">
      <button className="text-left text-sm font-medium hover:underline" onClick={() => onOpen(l.id)} type="button">
        {l.title}
      </button>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span className={cn('rounded-full border px-2 py-0.5 font-medium', t.className)} title={t.hint}>
          {t.label}
        </span>
        <span>seen {l.seen === 1 ? 'once' : `${l.seen} times`}</span>
        {l.source ? <span>from {l.source}</span> : null}
        <span>{new Date(l.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</span>
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {l.trust !== 'confirmed' && (
          <Button disabled={cmd.busy} onClick={() => void cmd.run({ type: 'confirmLesson', id: l.id })} size="sm" variant="outline">
            <Check aria-hidden="true" className="size-4" /> Confirm
          </Button>
        )}
        <HoldButton
          completeLabel="Retired"
          disabled={cmd.busy}
          holdingLabel="Keep holding"
          icon={Archive}
          onHoldComplete={() => void cmd.run({ type: 'retireLesson', id: l.id })}
          variant="danger"
        >
          Hold to retire
        </HoldButton>
        <span className="text-xs text-muted">Retired lessons are kept in the archive.</span>
      </div>
      <CommandError message={cmd.error} onDismiss={cmd.clear} />
    </li>
  );
}

/** Lessons (01-E10): "Don't … because …", learned from failed or retried work and shown at boot. */
export function LessonsPanel({ lessons, onOpen }: { lessons: LessonView[]; onOpen: (id: string) => void }) {
  return (
    <section aria-labelledby="lessons-title" className={card} data-testid="lessons">
      <h2 className="m-0 flex items-center gap-2 font-display text-base font-semibold" id="lessons-title">
        <BookOpenCheck aria-hidden="true" className="size-4 text-honey" /> Lessons
        {lessons.length > 0 && <span className="text-xs font-normal text-muted">{lessons.length}</span>}
      </h2>
      {lessons.length === 0 ? (
        <p className="m-0 text-sm text-muted" data-testid="lessons-empty">
          No lessons yet. When a card fails or has to be redone, the hive notes what to avoid next time, and every agent sees it
          first.
        </p>
      ) : (
        <ul aria-label="Lessons" className="m-0 flex max-h-[260px] list-none flex-col gap-2 overflow-y-auto p-0">
          {lessons.map((l) => (
            <LessonItem key={l.id} lesson={l} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The top row of the Brain screen: health, the Librarian and lessons (hidden until the hive reports them). */
export function BrainCareRow({ onOpen }: { onOpen: (id: string) => void }) {
  const { snapshot } = useHive();
  if (!snapshot?.brainHealth || !snapshot.librarian) return null;
  return (
    <div aria-label="How the Brain looks after itself" className="grid w-full grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4" role="region">
      <HealthPanel health={snapshot.brainHealth} />
      <LibrarianCard librarian={snapshot.librarian} />
      <LessonsPanel lessons={snapshot.lessons ?? []} onOpen={onOpen} />
    </div>
  );
}
