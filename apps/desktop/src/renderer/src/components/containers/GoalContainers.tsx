import type { ContainerStatus, GoalView } from '@insectoids/shared';
import { Box } from 'lucide-react';
import { useState } from 'react';
import { Switch } from '@/components/connections/Switch';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { runCommand } from '@/lib/hive-store';
import { modeLabel, notReadyWords, openContainerSettings } from './words';

const FINISHED = new Set<GoalView['status']>(['done', 'cancelled']);

/**
 * A goal's container choice on the Queen's goal view (Phase 4 D2): the current choice in words and a switch to force
 * containers for this goal (or go back to following the setting) with `setGoalContainers`. It applies to the goal's
 * next runs, so a finished goal shows its choice without the switch. When the goal is forced but Docker or the image
 * isn't ready, it says so: its cards wait (never run on this computer instead). `status` comes from the Queen screen
 * (one read for every goal); null while unknown, and then it says nothing about readiness.
 */
export function GoalContainers({ goal, status }: { goal: GoalView; status: ContainerStatus | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const forced = goal.containers === 'always';
  const finished = FINISHED.has(goal.status);
  const mode = status?.settings.mode ?? null;
  const notReady = status ? notReadyWords(status) : null;
  // Worth a note only when every card of this goal needs a container ("When needed" cards say so on their own chip).
  const needs = forced || mode === 'always';

  const words = forced
    ? 'Every card of this goal runs in a container, whatever the setting.'
    : mode === 'always'
      ? 'Follows the container setting (Every card): every card runs in a container.'
      : mode === 'auto'
        ? 'Follows the container setting (When needed): cards the Queen marks as risky or the Watchdog moves run in a container.'
        : mode === 'off'
          ? `Follows the container setting (${modeLabel('off')}): its cards run on this computer, guarded as usual.`
          : 'Follows the container setting.';

  const set = async (on: boolean): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await runCommand({ type: 'setGoalContainers', goalId: goal.id, containers: on ? 'always' : 'auto' });
    if (!r.ok) setError(r.error);
    setBusy(false);
  };

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-[14px] border border-line bg-surface p-3.5" data-containers={goal.containers} data-testid="goal-containers">
      <p className="m-0 flex min-w-0 items-start gap-2 text-[13px]">
        <Box aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted" />
        <span>
          <span className="font-semibold">Containers: </span>
          <span data-testid="goal-containers-words">{words}</span>
        </span>
      </p>
      {finished ? null : (
        // The visible words and the switch's name are the same sentence (label in name, WCAG 2.5.3).
        <div className="flex flex-wrap items-center justify-between gap-x-3 border-t border-line pt-2">
          <span aria-hidden="true" className="text-[13px] text-text">
            Run this goal&apos;s cards in containers
          </span>
          <Switch checked={forced} disabled={busy} label="Run this goal's cards in containers" onChange={(on) => void set(on)} />
        </div>
      )}
      {needs && notReady && !finished ? (
        <InlineAlert
          actions={[{ label: 'Open container settings', onClick: openContainerSettings }]}
          message={`${notReady} This goal's cards that need a container wait until it is. They never run on this computer instead.`}
          title="Containers aren't ready"
          tone="waiting"
        />
      ) : null}
      {error ? <InlineAlert message={error} onDismiss={() => setError(null)} title="Couldn't change this goal's containers" tone="error" /> : null}
    </div>
  );
}
