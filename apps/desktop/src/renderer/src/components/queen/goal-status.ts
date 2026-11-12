import type { CardView, GoalStatusView, GoalView, HiveSnapshot, LaneStatus } from '@insectoids/shared';

/** Plain words + status colour for a goal (status is never colour-only). */
export const GOAL_STATUS: Record<GoalStatusView, { label: string; dot: LaneStatus }> = {
  planning: { label: 'Queen is planning', dot: 'working' },
  awaiting_approval: { label: 'Waiting for you', dot: 'waiting' },
  running: { label: 'Working', dot: 'working' },
  stuck: { label: 'Stuck', dot: 'blocked' },
  done: { label: 'Done', dot: 'done' },
  cancelled: { label: 'Cancelled', dot: 'idle' },
};

export interface GoalProgress {
  wave: number;
  waves: number;
  done: number;
  total: number;
  working: number;
  blocked: number;
}

export function goalProgress(goal: GoalView, cards: CardView[], snap: HiveSnapshot): GoalProgress {
  const mine = cards.filter((c) => c.goalId === goal.id);
  return {
    wave: goal.currentWave,
    waves: goal.plan?.waves.length ?? 0,
    done: mine.filter((c) => c.status === 'done').length,
    total: goal.plan ? goal.plan.waves.reduce((n, w) => n + w.cards.length, 0) : mine.length,
    working: snap.agents.filter((a) => a.goalId === goal.id && a.status === 'working').length,
    blocked: mine.filter((c) => c.status === 'blocked').length,
  };
}

/** The goal the hive is busy with (newest active), else the newest goal. */
export function currentGoal(snap: HiveSnapshot | null): GoalView | null {
  if (!snap || snap.goals.length === 0) return null;
  return snap.goals.find((g) => g.status === 'running' || g.status === 'awaiting_approval' || g.status === 'planning') ?? snap.goals[0] ?? null;
}

const nf = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
export const tokens = (n: number): string => nf.format(n);
export const usd = (n: number): string => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`);
