import type { CardView, GoalView } from '@insectoids/shared';

/** Card status as words plus a status colour token (never colour-only, App 07). */
export function cardStatus(c: Pick<CardView, 'status' | 'undone'>): { label: string; dot: string } {
  if (c.undone) return { label: 'Undone', dot: 'bg-st-paused' };
  switch (c.status) {
    case 'open':
      return { label: 'Open', dot: 'bg-st-idle' };
    case 'claimed':
    case 'in_progress':
      return { label: 'Working', dot: 'bg-st-working' };
    case 'blocked':
      return { label: 'Blocked', dot: 'bg-st-blocked' };
    case 'review':
      return { label: 'In review', dot: 'bg-st-waiting' };
    case 'done':
      return { label: 'Done', dot: 'bg-st-done' };
    case 'failed':
      return { label: 'Failed', dot: 'bg-st-blocked' };
  }
}

export function goalStatus(g: Pick<GoalView, 'status'>): { label: string; dot: string } {
  switch (g.status) {
    case 'planning':
      return { label: 'Planning', dot: 'bg-st-working' };
    case 'awaiting_approval':
      return { label: 'Waiting for you', dot: 'bg-st-waiting' };
    case 'running':
      return { label: 'Running', dot: 'bg-st-working' };
    case 'stuck':
      return { label: 'Stuck', dot: 'bg-st-blocked' };
    case 'done':
      return { label: 'Done', dot: 'bg-st-done' };
    case 'cancelled':
      return { label: 'Cancelled', dot: 'bg-st-idle' };
  }
}
