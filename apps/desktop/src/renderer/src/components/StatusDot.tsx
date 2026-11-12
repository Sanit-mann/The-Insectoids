import type { AgentStatus } from '@insectoids/shared';
import { cn } from '@/lib/utils';

const COLOR: Record<AgentStatus, string> = {
  working: 'bg-st-working',
  waiting: 'bg-st-waiting',
  blocked: 'bg-st-blocked',
  done: 'bg-st-done',
  paused: 'bg-st-paused',
  idle: 'bg-st-idle',
};

/** Status is never colour-only: callers always show the label next to the dot. */
export function StatusDot({ status }: { status: AgentStatus }) {
  return <span aria-hidden="true" className={cn('inline-block size-[9px] shrink-0 rounded-full', COLOR[status])} />;
}
