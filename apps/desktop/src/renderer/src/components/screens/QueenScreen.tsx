import { useEffect, useId, useRef, useState } from 'react';
import type { ApprovalView, ContainerStatus, GoalView, HiveSnapshot } from '@insectoids/shared';
import { Box, FolderGit2, FolderOpen } from 'lucide-react';
import { decide } from '@/components/approvals/kinds';
import { AIPrompt } from '@/components/kokonutui/ai-prompt';
import { EmptyState } from '@/components/kokonutui/empty-state';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { useContainerStatus } from '@/components/containers/useContainerStatus';
import { notReadyWords } from '@/components/containers/words';
import { GoalThread } from '@/components/queen/GoalThread';
import { useProjectPicker } from '@/components/queen/useProjectPicker';
import { BrandMark } from '@/components/BrandMark';
import { refresh, runCommand, useHive } from '@/lib/hive-store';

const engineReady = (s: HiveSnapshot): boolean => s.engine.state === 'ready' || s.engine.state === 'fake';

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the hive" className="mx-auto flex w-full max-w-[860px] flex-1 flex-col gap-4 p-6">
      {[70, 45, 85].map((w) => (
        <div className="h-16 rounded-[14px] bg-surface-2 motion-safe:animate-pulse" key={w} style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

function BudgetField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      Budget
      <input
        aria-label="Token budget for this goal (optional)"
        className="h-8 w-24 rounded-[8px] border border-line bg-surface px-2 text-[13px] text-text outline-none focus-visible:border-honey"
        inputMode="numeric"
        onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ''))}
        placeholder="default"
        value={value}
      />
      tokens
    </label>
  );
}

/**
 * Phase 4 D2: "Run this goal's cards in containers" for the goal being written (sends containers: 'always'). A native
 * checkbox, like the Brain's export options. When Docker or the image isn't ready, the note under the composer says
 * the goal's cards will wait, and the checkbox points at it.
 */
function ContainersField({ checked, onChange, status, noteId }: { checked: boolean; onChange: (v: boolean) => void; status: ContainerStatus | null; noteId: string }) {
  const id = useId();
  const warn = checked && status !== null && notReadyWords(status) !== null;
  return (
    <label className="flex min-h-8 cursor-pointer items-center gap-1.5 text-xs text-muted" htmlFor={id}>
      <input
        aria-describedby={warn ? noteId : undefined}
        checked={checked}
        className="size-4 accent-honey"
        data-testid="goal-containers-option"
        id={id}
        onChange={(e) => onChange(e.target.checked)}
        type="checkbox"
      />
      <Box aria-hidden="true" className="size-3.5" />
      Run this goal&apos;s cards in containers
    </label>
  );
}

/** Phase 1: your one conversation with the hive (App 07 Queen chat). */
export function QueenScreen() {
  const { snapshot: snap, error, loading } = useHive();
  const picker = useProjectPicker();
  const [budget, setBudget] = useState('');
  const [boxed, setBoxed] = useState(false);
  const containers = useContainerStatus();
  const boxNoteId = useId();
  const [seed, setSeed] = useState<{ key: number; text: string } | undefined>(undefined);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const goalCount = snap?.goals.length ?? 0;

  // Keep the newest goal in view when one is added.
  useEffect(() => {
    if (goalCount > 0) endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [goalCount]);

  if (!snap) {
    if (loading) return <Skeleton />;
    return (
      <div className="mx-auto w-full max-w-[860px] p-6">
        <InlineAlert
          actions={[{ label: 'Try again', onClick: () => void refresh(), primary: true }]}
          message={error ?? 'Unknown error.'}
          title="Can't reach the hive"
          tone="error"
        />
      </div>
    );
  }

  if (!snap.project) {
    return (
      <div className="mx-auto flex w-full max-w-[860px] flex-1 flex-col justify-center gap-4 p-6">
        <EmptyState
          description="Pick the folder of the project you want the hive to work on. Insects only ever work in safe copies of it, and nothing reaches your branch without your approval."
          icon={FolderGit2}
          primary={{ label: picker.picking ? 'Opening…' : 'Choose project folder', onClick: () => void picker.pick(), icon: FolderOpen }}
          title="Choose a project for the hive"
        />
        {picker.error && <InlineAlert message={picker.error} onDismiss={picker.clearError} title="That folder can't be used" tone="error" />}
      </div>
    );
  }

  const ready = engineReady(snap);
  const goals = [...snap.goals].reverse(); // oldest first, like a conversation
  const boxNote = boxed && containers ? notReadyWords(containers) : null;
  const disabledReason = ready ? null : `The Queen can't start yet: ${snap.engine.message}`;

  const submit = async (text: string): Promise<boolean> => {
    setActionError(null);
    const n = Number(budget);
    const r = await runCommand({
      type: 'submitGoal',
      text,
      ...(budget && n > 0 ? { budgetTokens: n } : {}),
      ...(boxed ? { containers: 'always' as const } : {}),
    });
    if (!r.ok) setActionError(r.error);
    // The choice is for the goal just sent; the next goal starts from "follow the setting" again.
    else setBoxed(false);
    return r.ok;
  };

  const adjust = (goal: GoalView, approval: ApprovalView) => {
    decide(approval, false)
      .then(() => setSeed((s) => ({ key: (s?.key ?? 0) + 1, text: goal.text })))
      .catch((e: unknown) => setActionError(e instanceof Error ? e.message : String(e)));
  };

  const recheck = async () => {
    setRechecking(true);
    await refresh();
    setRechecking(false);
  };

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex-1">
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-6 p-6">
          {!ready && (
            <InlineAlert
              actions={[{ label: 'Check again', onClick: () => void recheck(), primary: true }]}
              busy={rechecking || snap.engine.state === 'checking'}
              message={snap.engine.message}
              title={snap.engine.state === 'checking' ? `Checking ${snap.engine.name}…` : `${snap.engine.name} isn't ready`}
              tone={snap.engine.state === 'checking' ? 'waiting' : 'error'}
            />
          )}
          {goals.length === 0 ? (
            <div className="flex flex-col items-center gap-4 py-10 text-center">
              <BrandMark size={64} />
              <h2 className="m-0 font-display text-2xl font-semibold">Give the hive its first goal</h2>
              <p className="m-0 max-w-[520px] text-muted">
                Tell the Queen what you want done. She plans it in waves, insects do the work in safe copies of your files,
                and nothing reaches your project without your approval.
              </p>
            </div>
          ) : (
            <section aria-label="Conversation with the Queen" className="flex flex-col gap-8">
              {goals.map((g) => (
                <GoalThread containers={containers} goal={g} key={g.id} onAdjust={adjust} onError={setActionError} snap={snap} />
              ))}
            </section>
          )}
          <div ref={endRef} />
        </div>
      </div>
      <div className="sticky bottom-0 z-10 border-t border-line bg-ground/90 px-6 py-4 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-2.5">
          {actionError && <InlineAlert message={actionError} onDismiss={() => setActionError(null)} title="That didn't work" tone="error" />}
          <AIPrompt
            disabledReason={disabledReason}
            footer={
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <BudgetField onChange={setBudget} value={budget} />
                <ContainersField checked={boxed} noteId={boxNoteId} onChange={setBoxed} status={containers} />
              </div>
            }
            header={
              <>
                <FolderGit2 aria-hidden="true" className="size-3.5" />
                <span>
                  Project <strong className="font-semibold text-text">{snap.project.name}</strong>
                  {snap.project.branch && <> · merges into {snap.project.branch}</>}
                </span>
                <span className="min-w-0 truncate" title={snap.project.path}>
                  {snap.project.path}
                </span>
                <button className="ml-auto min-h-8 rounded-[8px] px-2 text-honey-text hover:bg-surface-2" onClick={() => void picker.pick()} type="button">
                  {picker.picking ? 'Opening…' : 'Change project'}
                </button>
              </>
            }
            label="Message the Queen"
            onSubmit={submit}
            seed={seed}
          />
          {boxNote && (
            <p className="m-0 flex items-start gap-2 px-1 text-xs text-muted" data-testid="goal-containers-note" id={boxNoteId}>
              <Box aria-hidden="true" className="mt-px size-3.5 shrink-0" />
              <span>
                {boxNote} This goal&apos;s cards will wait until it is (Settings → Containers); they never run on this computer instead.
              </span>
            </p>
          )}
          {picker.error && <InlineAlert message={picker.error} onDismiss={picker.clearError} title="That folder can't be used" tone="error" />}
        </div>
      </div>
    </div>
  );
}
