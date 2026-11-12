import type { AgentStatus, AgentView, CardView, LaneStatus } from '@insectoids/shared';

/** Dot colour for a lane status. StatusDot has no "failed"; failed reads as blocked (the label says Failed). */
export const laneDot = (s: LaneStatus): AgentStatus => (s === 'failed' ? 'blocked' : s);

export const LANE_LABEL: Record<LaneStatus, string> = {
  working: 'Working',
  waiting: 'Waiting',
  blocked: 'Blocked',
  done: 'Done',
  paused: 'Paused',
  idle: 'Idle',
  failed: 'Failed',
};

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
export const casteLabel = cap;

export const roleLabel = (a: Pick<AgentView, 'role' | 'caste'>): string =>
  a.role === 'queen' ? 'Queen' : a.role === 'inspector' ? 'Inspector' : a.caste ? cap(a.caste) : 'Insect';

/** "Coder · Ant-07", "Queen", "Inspector · Ant-03". */
export function agentName(a: Pick<AgentView, 'role' | 'caste' | 'agentId'>): string {
  const role = roleLabel(a);
  return a.agentId && a.agentId.toLowerCase() !== role.toLowerCase() ? `${role} · ${a.agentId}` : role;
}

/** "sonnet · medium"; "—" until the engine reports what actually ran. */
export const modelLabel = (a: Pick<AgentView, 'model' | 'effort'>): string =>
  a.model ? (a.effort ? `${a.model} · ${a.effort}` : a.model) : '—';

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export const formatUsd = (n: number): string => (n === 0 ? '$0' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Card status -> dot colour and words. */
export const CARD_STATUS: Record<CardView['status'], { dot: AgentStatus; label: string }> = {
  open: { dot: 'idle', label: 'Open' },
  claimed: { dot: 'working', label: 'Claimed' },
  in_progress: { dot: 'working', label: 'In progress' },
  blocked: { dot: 'blocked', label: 'Blocked' },
  review: { dot: 'waiting', label: 'In review' },
  done: { dot: 'done', label: 'Done' },
  failed: { dot: 'blocked', label: 'Failed' },
};
