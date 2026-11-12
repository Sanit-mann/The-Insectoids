import type { CardView, GoalView } from '@insectoids/shared';
import { Columns3 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { StatusDot } from '@/components/StatusDot';
import { CARD_STATUS, casteLabel } from '@/components/hive/format';
import { useNow } from '@/components/hive/useNow';
import { CardDetail } from '@/components/taskboard/CardDetail';
import { EmptyHint, ReadError, SkeletonColumns } from '@/components/taskboard/states';
import { type KanbanColumn, KanbanBoard } from '@/components/ui/kanban-board';
import { useHive } from '@/lib/hive-store';
import { cn } from '@/lib/utils';

type WaveFilter = 'all' | number;

const COLUMNS: Array<Omit<KanbanColumn<CardView>, 'cards'> & { has: ReadonlyArray<CardView['status']> }> = [
  { id: 'open', title: 'Open', tone: 'idle', has: ['open'] },
  { id: 'progress', title: 'In progress', tone: 'working', has: ['claimed', 'in_progress'] },
  { id: 'blocked', title: 'Blocked', tone: 'blocked', has: ['blocked'] },
  { id: 'review', title: 'Review', tone: 'waiting', has: ['review'] },
  // Failed cards end here too, labelled "Failed": both are finished, and a sixth column would mostly sit empty.
  { id: 'done', title: 'Done', tone: 'done', has: ['done', 'failed'] },
];

/** The goal shown first: the newest running goal, else the newest goal. Goals arrive newest first. */
const defaultGoal = (goals: GoalView[]): GoalView | undefined => goals.find((g) => g.status === 'running') ?? goals[0];

const GOAL_STATUS: Record<GoalView['status'], string> = {
  planning: 'planning',
  awaiting_approval: 'waiting for you',
  running: 'running',
  stuck: 'stuck',
  done: 'done',
  cancelled: 'cancelled',
};

function CardFace({ card }: { card: CardView }) {
  const st = CARD_STATUS[card.status];
  return (
    <>
      <span className="flex items-center gap-1.5">
        <span className="rounded-full border border-line px-2 py-px text-[11px]">{casteLabel(card.caste)}</span>
        {card.undone && <span className="rounded-full border border-st-paused/60 px-2 py-px text-[11px]">Undone</span>}
        <span className="ml-auto text-[11px] text-muted">{casteLabel(card.priority)}</span>
      </span>
      <span className="font-semibold leading-snug">{card.title}</span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
        {card.status === 'failed' && (
          <span className="flex items-center gap-1 text-text">
            <StatusDot status={st.dot} />
            Failed
          </span>
        )}
        <span>
          Attempt {card.attempts}/{card.maxAttempts}
        </span>
        {card.claimedBy && <span>· {card.claimedBy}</span>}
        {card.escalated && <span>· escalated</span>}
      </span>
    </>
  );
}

export function TaskboardScreen() {
  const { snapshot, error, loading } = useHive();
  const now = useNow(1000);
  const [goalId, setGoalId] = useState<string | null>(null);
  const [wave, setWave] = useState<WaveFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  const goals = useMemo(() => snapshot?.goals ?? [], [snapshot]);
  const goal = goals.find((g) => g.id === goalId) ?? defaultGoal(goals);
  const goalCards = useMemo(() => (goal && snapshot ? snapshot.cards.filter((c) => c.goalId === goal.id) : []), [goal, snapshot]);
  const waveCount = Math.max(goal?.plan?.waves.length ?? 0, ...goalCards.map((c) => c.wave), 0);
  const shown = wave === 'all' ? goalCards : goalCards.filter((c) => c.wave === wave);
  const columns: Array<KanbanColumn<CardView>> = COLUMNS.map(({ has, ...col }) => ({
    ...col,
    cards: shown.filter((c) => has.includes(c.status)).sort((a, b) => a.wave - b.wave || a.updatedAt - b.updatedAt),
  }));
  const opened = goalCards.find((c) => c.id === openId) ?? null;

  if (loading && !snapshot) return <SkeletonColumns label="Loading the taskboard" />;
  if (error && !snapshot) return <ReadError message={error} />;
  if (!goal) {
    return (
      <EmptyHint icon={Columns3} title="No task cards yet">
        Give the Queen a goal. She plans it as task cards in waves, and they appear here as insects pull them.
      </EmptyHint>
    );
  }

  const waveState = (n: number): string => {
    const cs = goalCards.filter((c) => c.wave === n);
    if (cs.length === 0) return 'planned';
    if (cs.every((c) => c.status === 'done')) return 'done';
    return n === goal.currentWave ? 'now' : 'posted';
  };

  return (
    <div className="flex min-h-0 flex-1 flex-wrap">
      <div className="flex min-w-0 flex-[999_1_640px] flex-col gap-3 p-4">
        {error && <ReadError message={error} />}
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Goal</span>
            <select
              value={goal.id}
              onChange={(e) => {
                setGoalId(e.target.value);
                setWave('all');
                setOpenId(null);
              }}
              className="min-h-10 max-w-[320px] rounded-full border border-line bg-surface px-3 text-text"
            >
              {goals.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title} ({GOAL_STATUS[g.status]})
                </option>
              ))}
            </select>
          </label>
          <div role="group" aria-label="Wave" className="flex flex-wrap gap-1.5">
            {(['all', ...Array.from({ length: waveCount }, (_, i) => i + 1)] as WaveFilter[]).map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={wave === w}
                onClick={() => setWave(w)}
                className={cn(
                  'min-h-10 rounded-full border bg-surface px-3 text-sm',
                  wave === w ? 'border-honey text-honey-text' : 'border-line text-text hover:border-[#4a4232]',
                )}
              >
                {w === 'all' ? 'All waves' : `Wave ${w} · ${waveState(w)}`}
              </button>
            ))}
          </div>
          <span className="ml-auto text-xs text-muted">Insects pull cards for their caste. Nobody assigns them.</span>
        </div>

        {goalCards.length === 0 ? (
          <EmptyHint icon={Columns3} title={goal.status === 'awaiting_approval' ? 'The plan is waiting for you' : 'No cards posted yet'}>
            {goal.status === 'awaiting_approval'
              ? 'Approve the Queen’s plan in Approvals and wave 1 is posted here.'
              : goal.status === 'planning'
                ? 'The Queen is planning this goal.'
                : 'Cards appear here as soon as a wave is posted.'}
          </EmptyHint>
        ) : (
          <KanbanBoard
            columns={columns}
            getId={(c) => c.id}
            getLabel={(c) => `${c.title}. ${CARD_STATUS[c.status].label}. ${casteLabel(c.caste)}, wave ${c.wave}.`}
            renderCard={(c) => <CardFace card={c} />}
            selectedId={openId}
            onOpen={(id) => setOpenId((cur) => (cur === id ? null : id))}
            emptyText="No cards"
          />
        )}
      </div>
      {opened && <CardDetail card={opened} cards={goalCards} now={now} onClose={() => setOpenId(null)} />}
    </div>
  );
}
