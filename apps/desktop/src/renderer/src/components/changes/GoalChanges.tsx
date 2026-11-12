import { GitMerge, Inbox, RotateCcw, Undo2 } from 'lucide-react';
import { useState } from 'react';
import type { ApprovalView, CardView, GoalView } from '@insectoids/shared';
import { HoldButton } from '@/components/kokonutui/hold-button';
import { runCommand } from '@/lib/hive-store';
import { cn } from '@/lib/utils';
import { InlineError } from './CardChanges';
import { openScreen } from './navigate';
import { goalStatus } from './status';

interface GoalChangesProps {
  goal: GoalView;
  cards: CardView[];
  approvals: ApprovalView[];
  /** The user's branch merges go into. */
  branch: string | null;
}

const btn =
  'inline-flex min-h-10 items-center gap-2 rounded-[10px] border border-line bg-surface-2 px-3.5 font-semibold hover:bg-active disabled:cursor-not-allowed disabled:opacity-50';

/** A goal: what it changed overall, Undo goal (hold, destructive) and the merge into the user's branch. */
export function GoalChanges({ goal, cards, approvals, branch }: GoalChangesProps) {
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const gs = goalStatus(goal);
  const target = branch ?? 'your branch';
  const done = cards.filter((c) => c.status === 'done' && !c.undone).length;
  const waitingMerge = approvals.find((a) => a.goalId === goal.id && a.status === 'waiting' && a.kind === 'merge');

  const run = async (cmd: Parameters<typeof runCommand>[0], ok: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setNote(null);
    const r = await runCommand(cmd);
    setBusy(false);
    if (r.ok) setNote(ok);
    else setError(r.error);
  };

  const canUndoGoal = done > 0 && goal.merge !== 'merged' && goal.status !== 'cancelled';

  return (
    <section aria-labelledby="goal-title" className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 id="goal-title" className="m-0 font-display text-xl font-semibold">
          {goal.title}
        </h2>
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <span aria-hidden="true" className={cn('inline-block size-2 rounded-full', gs.dot)} />
          {gs.label} · {done} of {cards.length} cards merged into the goal
        </span>
      </header>

      <div data-testid="merge-panel" data-merge={goal.merge} className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
        <h3 className="m-0 flex items-center gap-2 font-display text-base font-semibold">
          <GitMerge aria-hidden="true" className="size-4 text-honey" />
          Merge into {target}
        </h3>
        {goal.merge === 'not-merged' && (
          <p className="m-0 text-sm text-muted">
            Not merged. When the last wave passes inspection, the Queen asks you before anything reaches {target}.
          </p>
        )}
        {goal.merge === 'awaiting-approval' && (
          <p className="m-0 text-sm">Waiting for your approval. Nothing reaches {target} until you say yes.</p>
        )}
        {goal.merge === 'merged' && (
          <p className="m-0 text-sm">
            Merged into {target}. You can undo it; undoing needs your approval too, because it changes your branch.
          </p>
        )}
        {goal.merge === 'undone' && <p className="m-0 text-sm">The merge was undone; {target} is back as it was. You can merge again.</p>}

        <div className="flex flex-wrap gap-2">
          {(goal.merge === 'awaiting-approval' || waitingMerge) && (
            <button type="button" className={btn} onClick={() => openScreen('approvals')}>
              <Inbox aria-hidden="true" className="size-4" /> Open Approvals
            </button>
          )}
          {goal.merge === 'merged' && (
            <button
              type="button"
              className={btn}
              disabled={busy}
              onClick={() => void run({ type: 'requestUndoMerge', goalId: goal.id }, 'Undo requested. Approve it in Approvals to change your branch.')}
            >
              <Undo2 aria-hidden="true" className="size-4" /> Undo merge
            </button>
          )}
          {goal.merge === 'undone' && (
            <button
              type="button"
              className={btn}
              disabled={busy}
              onClick={() => void run({ type: 'requestRedoMerge', goalId: goal.id }, 'Merge requested. Approve it in Approvals.')}
            >
              <RotateCcw aria-hidden="true" className="size-4" /> Merge again
            </button>
          )}
        </div>
        {note && (
          <p role="status" className="m-0 text-sm text-st-waiting">
            {note}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4">
        <h3 className="m-0 font-display text-base font-semibold">Undo the whole goal</h3>
        <p className="m-0 text-sm text-muted">
          Resets the goal&apos;s branch to where it started. Your branch is not touched, and the old work is kept in an archive, never deleted.
          {goal.merge === 'merged' && ' Undo the merge into your branch first.'}
        </p>
        <div>
          <HoldButton
            variant="danger"
            icon={Undo2}
            disabled={!canUndoGoal || busy}
            holdingLabel="Keep holding to undo"
            completeLabel="Goal undone"
            resetAfter={0}
            data-testid="undo-goal"
            onHoldComplete={() => void run({ type: 'undoGoal', goalId: goal.id }, 'The goal was undone.')}
          >
            Hold to undo goal
          </HoldButton>
        </div>
      </div>

      {error && <InlineError message={error} />}
    </section>
  );
}
