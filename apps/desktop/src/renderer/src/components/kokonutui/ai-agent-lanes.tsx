/**
 * Agent lanes timeline, adapted from Kokonut UI `ai-agent-lanes` (https://kokonutui.com, MIT).
 *
 * Kept from Kokonut UI: one lane per agent with a label column, bars on a shared time track, a playhead
 * at "now", selectable lane labels, the finished check mark, the hover tooltip and the motion easing.
 * Changed for The Insectoids: driven by real runs instead of a scripted replay (no play/scrub/demo data,
 * no lead/sub-agent connectors); one bar per run from start to end (or now), coloured by status with
 * our status tokens; labels are buttons that select the lane shown in the output panel.
 */
import { Check } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

export type LaneTone = 'working' | 'waiting' | 'blocked' | 'done' | 'paused' | 'idle';

export interface TimelineLane {
  id: string;
  name: string;
  /** Short task line for the tooltip. */
  task: string;
  /** Epoch ms. */
  start: number;
  /** Epoch ms; null while running. */
  end: number | null;
  tone: LaneTone;
  /** Status label (never colour-only). */
  statusLabel: string;
}

export interface AgentLanesTimelineProps {
  lanes: TimelineLane[];
  now: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  className?: string;
}

const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const LANE_H = 36;

const TONE_BG: Record<LaneTone, string> = {
  working: 'bg-st-working',
  waiting: 'bg-st-waiting',
  blocked: 'bg-st-blocked',
  done: 'bg-st-done',
  paused: 'bg-st-paused',
  idle: 'bg-st-idle',
};

const formatSpan = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

export function AgentLanesTimeline({ lanes, now, selectedId, onSelect, className }: AgentLanesTimelineProps) {
  const [hover, setHover] = useState<string | null>(null);
  if (lanes.length === 0) return null;

  const from = Math.min(...lanes.map((l) => l.start));
  // Keep a little room after "now" so the playhead never sits on the edge.
  const to = Math.max(now, ...lanes.map((l) => l.end ?? now)) + 2_000;
  const span = Math.max(1, to - from);
  const pct = (t: number): string => `${((t - from) / span) * 100}%`;
  const hovered = lanes.find((l) => l.id === hover);

  return (
    <div className={cn('rounded-2xl border border-line bg-surface p-4', className)}>
      <div className="mb-2 flex items-center justify-between text-[11px] text-muted">
        <span>Timeline</span>
        <span className="font-mono tabular-nums">{formatSpan(now - from)}</span>
      </div>
      <div className="flex">
        <ul className="m-0 w-[132px] shrink-0 list-none p-0">
          {lanes.map((lane) => {
            const finished = lane.end !== null && lane.tone === 'done';
            const active = lane.id === selectedId;
            return (
              <li key={lane.id} style={{ height: LANE_H }}>
                <button
                  type="button"
                  aria-pressed={active}
                  aria-label={`${lane.name}, ${lane.statusLabel}`}
                  onClick={() => onSelect(lane.id)}
                  className={cn(
                    '-ml-1.5 flex h-7 max-w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] transition-colors',
                    active ? 'bg-active font-medium text-honey-text' : 'text-muted hover:text-text',
                  )}
                >
                  <span className="relative flex size-3.5 shrink-0 items-center justify-center">
                    <AnimatePresence initial={false} mode="popLayout">
                      {finished ? (
                        <motion.span
                          key="done"
                          initial={{ opacity: 0, scale: 0.5 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.25, ease: EASE_OUT }}
                          className="flex size-3.5 items-center justify-center rounded-full bg-st-done text-honey-ink"
                        >
                          <Check className="size-2.5" strokeWidth={3} />
                        </motion.span>
                      ) : (
                        <motion.span key="dot" exit={{ opacity: 0 }} className={cn('size-2 rounded-full', TONE_BG[lane.tone])} />
                      )}
                    </AnimatePresence>
                  </span>
                  <span className="truncate">{lane.name}</span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="relative min-w-0 flex-1">
          {lanes.map((lane) => {
            const end = lane.end ?? now;
            return (
              <div key={lane.id} className="relative border-b border-dashed border-line last:border-b-0" style={{ height: LANE_H }}>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden="true"
                  onClick={() => onSelect(lane.id)}
                  onPointerEnter={() => setHover(lane.id)}
                  onPointerLeave={() => setHover(null)}
                  className="absolute top-1/2 h-4 min-w-[3px] -translate-y-1/2 rounded-[4px] px-px"
                  style={{ left: pct(lane.start), width: `max(3px, ${((end - lane.start) / span) * 100}%)` }}
                >
                  <span className={cn('block h-full rounded-[3px]', TONE_BG[lane.tone], lane.end === null && 'opacity-90')} />
                </button>
              </div>
            );
          })}
          {/* Playhead at "now", moved with translate so it skips layout. */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 -right-px left-0 overflow-hidden">
            <div className="h-full" style={{ translate: `${pct(now)} 0` }}>
              <div className="h-full w-px bg-text/70" />
            </div>
          </div>
          <AnimatePresence>
            {hovered && (
              <motion.div
                key={hovered.id}
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.08 } }}
                transition={{ duration: 0.14, ease: EASE_OUT }}
                className="pointer-events-none absolute z-20 w-56 -translate-y-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-[12px] shadow-lg"
                style={{ left: pct(hovered.start), top: lanes.indexOf(hovered) * LANE_H + 4 }}
              >
                <p className="m-0 flex items-center justify-between gap-2 text-[11px] text-muted">
                  <span>{hovered.statusLabel}</span>
                  <span className="font-mono tabular-nums">{formatSpan((hovered.end ?? now) - hovered.start)}</span>
                </p>
                <p className="m-0 mt-0.5 font-medium">{hovered.name}</p>
                <p className="m-0 mt-1 text-muted">{hovered.task}</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
