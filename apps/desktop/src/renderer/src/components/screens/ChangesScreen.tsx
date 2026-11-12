import { GitBranch } from 'lucide-react';
import { useState } from 'react';
import { CardChanges, InlineError } from '@/components/changes/CardChanges';
import { ChangesTree, type Selection } from '@/components/changes/ChangesTree';
import { GoalChanges } from '@/components/changes/GoalChanges';
import { refresh, useHive } from '@/lib/hive-store';

/**
 * Changes & undo (App 07): goal → wave → card tree; a card's diff with Undo card; a goal's merge into the
 * user's branch (needs approval, can be undone and redone) and Undo goal.
 */
export function ChangesScreen() {
  const { snapshot, error, loading } = useHive();
  const [selected, setSelected] = useState<Selection | null>(null);

  const goals = snapshot?.goals ?? [];
  const cards = snapshot?.cards ?? [];

  if (loading && !snapshot) {
    return (
      <div className="flex flex-1 gap-6 p-6" aria-busy="true">
        <div className="h-64 w-72 animate-pulse rounded-2xl border border-line bg-surface" />
        <div className="h-64 flex-1 animate-pulse rounded-2xl border border-line bg-surface" />
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="p-6">
        <InlineError message={`Could not read the hive: ${error ?? 'unknown error'}`} onRetry={() => void refresh()} />
      </div>
    );
  }

  if (goals.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <GitBranch size={40} strokeWidth={1.5} className="text-honey" aria-hidden="true" />
        <h2 className="m-0 font-display text-xl font-semibold">No changes yet</h2>
        <p className="m-0 max-w-[460px] text-muted">
          Give the Queen a goal. Every card the insects finish shows up here with its diff, and you can undo a card, a goal or a merge at any time.
        </p>
      </div>
    );
  }

  // Until the user picks: the newest goal's first finished card, else the goal itself.
  const picked = selected && goals.some((g) => g.id === selected.goalId) ? selected : null;
  const goal = goals.find((g) => g.id === picked?.goalId) ?? goals[0]!;
  const current: Selection = picked ?? {
    goalId: goal.id,
    cardId: cards.find((c) => c.goalId === goal.id && c.status === 'done')?.id ?? null,
  };
  const card = current.cardId ? cards.find((c) => c.id === current.cardId) : undefined;
  const goalCards = cards.filter((c) => c.goalId === goal.id);

  return (
    <div className="flex flex-1 flex-wrap items-start gap-6 p-6">
      <aside className="flex w-full flex-[1_1_260px] flex-col gap-2 md:max-w-[320px]">
        {error && <InlineError message={`Showing the last known state: ${error}`} onRetry={() => void refresh()} />}
        <ChangesTree goals={goals} cards={cards} selected={current} onSelect={setSelected} />
      </aside>
      <div className="flex min-w-0 flex-[999_1_480px] flex-col gap-6">
        {card ? (
          <>
            <CardChanges key={card.id} card={card} />
            <button type="button" className="self-start text-sm text-honey-text hover:underline" onClick={() => setSelected({ goalId: goal.id, cardId: null })}>
              Goal: {goal.title}, merge and undo
            </button>
          </>
        ) : (
          <GoalChanges goal={goal} cards={goalCards} approvals={snapshot.approvals} branch={snapshot.project?.branch ?? null} />
        )}
      </div>
    </div>
  );
}
