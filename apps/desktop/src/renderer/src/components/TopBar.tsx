import { Moon, Pause, Play, Sun } from 'lucide-react';
import type { AppInfo, LaneStatus } from '@insectoids/shared';
import { AwayDigestButton } from '@/components/digest/AwayDigestDialog';
import { StatusDot } from '@/components/StatusDot';
import { UpdateNotice } from '@/components/UpdateNotice';
import { currentGoal } from '@/components/queen/goal-status';
import { runCommand, useHive } from '@/lib/hive-store';
import type { Theme } from '@/lib/theme';

/** id of the screen's heading: the target of "Skip to main content" and of focus after a screen switch. */
export const SCREEN_TITLE_ID = 'screen-title';

interface TopBarProps {
  title: string;
  info: AppInfo | null;
  theme: Theme;
  onToggleTheme: () => void;
}

/** The background-work pill: what the hive is doing right now, in plain words. */
function useHivePill(): { label: string; status: LaneStatus } | null {
  const { snapshot: snap } = useHive();
  if (!snap?.project) return null;
  if (snap.hive.paused) return { label: snap.hive.pausedReason ? `Paused · ${snap.hive.pausedReason}` : 'Paused', status: 'paused' };
  const goal = currentGoal(snap);
  const working = snap.hive.working;
  const insects = `${working} ${working === 1 ? 'insect' : 'insects'} working`;
  if (goal?.status === 'running') {
    const waves = goal.plan?.waves.length ?? 0;
    return { label: waves ? `Wave ${Math.max(goal.currentWave, 1)} of ${waves} · ${insects}` : insects, status: 'working' };
  }
  if (goal?.status === 'planning') return { label: 'Queen is planning', status: 'working' };
  if (snap.approvals.some((a) => a.status === 'waiting')) return { label: 'Waiting for you', status: 'waiting' };
  return { label: 'Hive idle', status: 'idle' };
}

export function TopBar({ title, info, theme, onToggleTheme }: TopBarProps) {
  const next = theme === 'dark' ? 'light' : 'dark';
  const pill = useHivePill();
  const { snapshot: snap } = useHive();
  const paused = snap?.hive.paused ?? false;

  return (
    <header className="flex flex-wrap items-center gap-2.5 border-b border-line px-6 py-3.5">
      {/* The skip link and screen switches move focus here (tabIndex -1: focusable by script, not a Tab stop). */}
      <h1 className="m-0 rounded-md font-display text-xl font-semibold" id={SCREEN_TITLE_ID} tabIndex={-1}>
        {title}
      </h1>
      {pill && (
        <span
          aria-live="polite"
          className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-[13px]"
          data-testid="hive-pill"
        >
          <StatusDot className={pill.status === 'working' ? 'motion-safe:animate-pulse' : undefined} status={pill.status} />
          {pill.label}
        </span>
      )}
      <span className="ml-auto inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-[13px] text-muted">
        {info ? `v${info.version} · Electron ${info.electron}` : 'Connecting…'}
      </span>
      <UpdateNotice />
      <AwayDigestButton />
      {snap?.project && (
        <button
          className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[13px] text-muted hover:text-text"
          onClick={() => void runCommand(paused ? { type: 'resume' } : { type: 'pause', reason: 'Paused by you' })}
          type="button"
        >
          {paused ? <Play aria-hidden="true" size={14} /> : <Pause aria-hidden="true" size={14} />}
          {paused ? 'Resume hive' : 'Pause hive'}
        </button>
      )}
      <button
        aria-label={`Switch to ${next} theme`}
        className="inline-flex size-10 items-center justify-center rounded-full border border-line bg-surface text-muted hover:text-text"
        onClick={onToggleTheme}
        type="button"
      >
        {theme === 'dark' ? <Moon aria-hidden="true" size={16} /> : <Sun aria-hidden="true" size={16} />}
      </button>
    </header>
  );
}
