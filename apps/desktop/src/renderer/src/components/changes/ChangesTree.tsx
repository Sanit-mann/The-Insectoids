import type { CardView, GoalView } from '@insectoids/shared';
import { cn } from '@/lib/utils';
import { cardStatus, goalStatus } from './status';

export interface Selection {
  goalId: string;
  cardId: string | null;
}

interface ChangesTreeProps {
  goals: GoalView[];
  cards: CardView[];
  selected: Selection | null;
  onSelect: (s: Selection) => void;
}

/** Goal → wave → card tree (App 07, Changes & undo). */
export function ChangesTree({ goals, cards, selected, onSelect }: ChangesTreeProps) {
  return (
    <nav aria-label="Goals and cards" className="flex flex-col gap-3">
      {goals.map((g) => {
        const gs = goalStatus(g);
        const goalCards = cards.filter((c) => c.goalId === g.id);
        const waves = [...new Set(goalCards.map((c) => c.wave))].sort((a, b) => a - b);
        const goalSelected = selected?.goalId === g.id && selected.cardId === null;
        return (
          <section key={g.id} className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => onSelect({ goalId: g.id, cardId: null })}
              aria-current={goalSelected ? 'true' : undefined}
              className={cn(
                'flex min-h-10 w-full flex-col items-start gap-0.5 rounded-[10px] border border-transparent px-2.5 py-2 text-left hover:bg-surface-2',
                goalSelected && 'border-line bg-active',
              )}
            >
              <span className="font-display text-[15px] font-semibold">{g.title}</span>
              <span className="flex items-center gap-1.5 text-xs text-muted">
                <span aria-hidden="true" className={cn('inline-block size-2 rounded-full', gs.dot)} />
                {gs.label} · {goalCards.length} {goalCards.length === 1 ? 'card' : 'cards'}
              </span>
            </button>
            {waves.map((w) => (
              <div key={w} className="flex flex-col gap-0.5 pl-3">
                <span className="px-2.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Wave {w}</span>
                {goalCards
                  .filter((c) => c.wave === w)
                  .map((c) => {
                    const st = cardStatus(c);
                    const isSel = selected?.cardId === c.id;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        data-testid="changes-card"
                        data-card-id={c.id}
                        onClick={() => onSelect({ goalId: g.id, cardId: c.id })}
                        aria-current={isSel ? 'true' : undefined}
                        className={cn(
                          'flex min-h-10 w-full items-center gap-2 rounded-[10px] border border-transparent px-2.5 py-1.5 text-left hover:bg-surface-2',
                          isSel && 'border-line bg-active',
                        )}
                      >
                        <span aria-hidden="true" className={cn('inline-block size-2 shrink-0 rounded-full', st.dot)} />
                        <span className={cn('min-w-0 flex-1 truncate', c.undone && 'text-muted line-through')}>{c.title}</span>
                        <span className="shrink-0 text-xs text-muted">{st.label}</span>
                      </button>
                    );
                  })}
              </div>
            ))}
            {waves.length === 0 && <p className="m-0 pl-5 text-xs text-muted">No cards posted yet.</p>}
          </section>
        );
      })}
    </nav>
  );
}
