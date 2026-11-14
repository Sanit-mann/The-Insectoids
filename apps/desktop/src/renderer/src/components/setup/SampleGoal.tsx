import type { SampleEstimate, SetupState } from '@insectoids/shared';
import { Coins, FolderLock, Hexagon, LayoutGrid, LoaderCircle, Play, Sparkles, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatTokens, formatUsd } from '@/components/hive/format';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { runCommand, useHive } from '@/lib/hive-store';
import { setupActions } from '@/lib/setup-store';

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; estimate: SampleEstimate };

const range = (lo: number, hi: number, fmt: (n: number) => string): string => (lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`);

/**
 * The optional sample goal (Onboarding 08-D8; Phase 2 C5): a small goal on a practice project in its own
 * folder, so the user can watch the hive plan, work, get checked and finish without touching real files.
 * The estimate comes first; nothing runs until the user presses Start (a deliberate, separate button).
 */
export function SampleGoal({ state, onWatch }: { state: SetupState; onWatch: (screen: 'hive' | 'taskboard') => void }) {
  const { snapshot } = useHive();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ attempt: number; load: Load } | null>(null);
  const load: Load = result?.attempt === attempt ? result.load : { state: 'loading' };
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => {
        const api = window.insectoids?.setup;
        if (!api?.sampleEstimate) throw new Error('The sample goal is not available in this build.');
        return api.sampleEstimate();
      })
      .then((estimate) => alive && setResult({ attempt, load: { state: 'ready', estimate } }))
      .catch((err: unknown) => alive && setResult({ attempt, load: { state: 'error', message: err instanceof Error ? err.message : String(err) } }));
    return () => {
      alive = false;
    };
  }, [attempt]);

  const [switching, setSwitching] = useState(false);
  const [backError, setBackError] = useState<string | null>(null);
  // The project that was open before the sample switched to the practice folder (C5).
  const back = async (path: string): Promise<void> => {
    setSwitching(true);
    setBackError(null);
    const r = await runCommand({ type: 'setProject', path });
    setSwitching(false);
    if (!r.ok) setBackError(r.error);
  };

  const start = async (): Promise<void> => {
    setStarting(true);
    setError(null);
    const r = await setupActions.startSample();
    setStarting(false);
    if (!r.ok) setError(r.error);
  };

  // Started: the hive is working on it. The goal's live status comes from the hive snapshot.
  if (state.sample) {
    const goal = snapshot?.goals.find((g) => g.id === state.sample?.goalId);
    return (
      <div className="flex flex-col gap-4" data-testid="sample-started">
        <div className="flex items-start gap-3 rounded-2xl border border-line bg-surface p-4">
          <Sparkles aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-honey-text" />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="font-semibold text-text">The hive is working on the sample goal</span>
            <span className="text-sm text-muted" data-testid="sample-goal-status" role="status">
              {goal ? `${goal.title} · ${goal.status}` : 'Starting…'}
            </span>
            <span className="text-sm text-muted">
              It runs in the practice folder <code className="break-all font-mono text-[13px] text-text">{state.sample.practicePath}</code>. Your own
              files aren&rsquo;t touched.{' '}
              {state.previousProject
                ? 'When it is done, switch back to your own project with the button below.'
                : 'When you’re ready for your own project, choose it with the project picker on the Queen screen.'}
            </span>
          </div>
        </div>
        {backError ? <InlineAlert message={backError} onDismiss={() => setBackError(null)} title="Couldn't switch back" tone="error" /> : null}
        <div className="flex flex-wrap gap-2.5">
          {state.previousProject && snapshot?.project?.path !== state.previousProject ? (
            <Button data-testid="sample-back" disabled={switching} onClick={() => void back(state.previousProject!)} variant="outline">
              <Undo2 aria-hidden="true" />
              {switching ? 'Switching…' : 'Back to your project'}
            </Button>
          ) : null}
          <Button data-testid="sample-watch-hive" onClick={() => onWatch('hive')} variant="outline">
            <Hexagon aria-hidden="true" />
            Watch it in the Hive
          </Button>
          <Button data-testid="sample-watch-taskboard" onClick={() => onWatch('taskboard')} variant="outline">
            <LayoutGrid aria-hidden="true" />
            See its cards on the Taskboard
          </Button>
        </div>
      </div>
    );
  }

  if (load.state === 'loading') {
    return <div aria-busy="true" aria-label="Working out what the sample goal costs" className="h-40 rounded-2xl bg-surface-2 motion-safe:animate-pulse" role="status" />;
  }
  if (load.state === 'error') {
    return (
      <InlineAlert
        actions={[{ label: 'Try again', onClick: () => setAttempt((a) => a + 1), primary: true }]}
        message={load.message}
        title="Couldn't work out the sample goal's cost"
        tone="error"
      />
    );
  }

  const e = load.estimate;
  const cost = e.costUsdLow !== null && e.costUsdHigh !== null ? range(e.costUsdLow, e.costUsdHigh, formatUsd) : null;
  return (
    <div className="flex flex-col gap-4" data-testid="sample-estimate">
      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
        <span className="text-xs font-medium text-muted">The sample goal</span>
        <p className="m-0 font-semibold text-text" data-testid="sample-goal-text">
          {e.goalText}
        </p>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="flex items-center gap-1.5 text-muted">
            <Coins aria-hidden="true" className="size-4" /> Cost
          </dt>
          <dd className="m-0 text-text" data-testid="sample-cost">
            About {range(e.tokensLow, e.tokensHigh, formatTokens)} tokens{cost ? `, about ${cost}` : ''}
            {e.engine ? ` on ${e.engine}` : ''}.
            {e.note ? <span className="block text-muted">{e.note}</span> : null}
            <span className="block text-xs text-muted">{e.basis}</span>
          </dd>
          <dt className="flex items-center gap-1.5 text-muted">
            <FolderLock aria-hidden="true" className="size-4" /> Where
          </dt>
          <dd className="m-0 text-text">
            A practice project in its own folder: <code className="break-all font-mono text-[13px]">{e.practicePath}</code>. Your own files
            aren&rsquo;t touched.
            {snapshot?.project ? (
              <span className="block text-muted">
                Starting it makes the practice folder the open project. Switch back to {snapshot.project.name} with the project picker on the
                Queen screen.
              </span>
            ) : null}
          </dd>
        </dl>
      </div>

      {e.canRun ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button data-testid="sample-start" disabled={starting} onClick={() => void start()}>
            {starting ? <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" /> : <Play aria-hidden="true" />}
            {starting ? 'Starting…' : 'Start the sample goal'}
          </Button>
          <span className="text-sm text-muted">It only starts when you press this. The budget is capped at the high estimate.</span>
        </div>
      ) : (
        <InlineAlert message={e.reason ?? 'The sample goal can’t run right now.'} title="Can't run the sample yet" tone="waiting" />
      )}
      {error ? <InlineAlert message={error} onDismiss={() => setError(null)} title="Couldn't start the sample goal" tone="error" /> : null}
    </div>
  );
}
