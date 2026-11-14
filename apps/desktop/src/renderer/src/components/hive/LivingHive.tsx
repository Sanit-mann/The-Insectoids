import type { AgentView, LaneStatus } from '@insectoids/shared';
import {
  BarChart3,
  BookOpen,
  CheckCircle2,
  Circle,
  Clock,
  Code2,
  Crown,
  Eye,
  FileText,
  FlaskConical,
  HardHat,
  Hexagon,
  Loader,
  type LucideIcon,
  OctagonAlert,
  Palette,
  PauseCircle,
  PenLine,
  Search,
  ShieldCheck,
  Telescope,
  XCircle,
} from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { LANE_LABEL, agentName, roleLabel } from './format';

/**
 * The living hive (App 07 D4, Hive monitor; Phase 2 C4): every agent as a cell in a honeycomb. Custom by
 * design (App 07 lists it as having no match in the preferred libraries).
 *
 * Calm by default (App 07 principle 4): only working cells breathe, new cells fade in once, finished cells
 * sit still. The motion pauses whenever the view can't be seen (another tab, a hidden or minimised
 * window) and is off entirely under prefers-reduced-motion. Status is always words plus an icon, and the
 * cell outline colour only repeats it. Arrow keys move between cells; Enter or Space selects one.
 */

const ROLE_ICON: Record<string, LucideIcon> = {
  queen: Crown,
  inspector: ShieldCheck,
  librarian: BookOpen,
  scout: Telescope,
  foreman: HardHat,
  coder: Code2,
  tester: FlaskConical,
  reviewer: Eye,
  researcher: Search,
  documenter: FileText,
  designer: Palette,
  analyst: BarChart3,
  writer: PenLine,
};
const roleIcon = (a: AgentView): LucideIcon => ROLE_ICON[a.role === 'insect' ? (a.caste ?? '') : a.role] ?? Hexagon;

const STATUS_ICON: Record<LaneStatus, LucideIcon> = {
  working: Loader,
  waiting: Clock,
  blocked: OctagonAlert,
  done: CheckCircle2,
  paused: PauseCircle,
  idle: Circle,
  failed: XCircle,
};

/** Outline colour per status: it repeats the words, it never replaces them. */
const STROKE: Record<LaneStatus, string> = {
  working: 'var(--st-working)',
  waiting: 'var(--st-waiting)',
  blocked: 'var(--st-blocked)',
  failed: 'var(--st-blocked)',
  done: 'var(--st-done)',
  paused: 'var(--st-paused)',
  idle: 'var(--st-idle)',
};

// Pointy-top hexagons.
const R = 58;
const W = Math.sqrt(3) * R;
const ROW_H = 1.5 * R;
const PAD = 10;
const hexPoints = (r: number): string =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 180) * (60 * i - 90);
    return `${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`;
  }).join(' ');
const HEX = hexPoints(R - 2);
const GLOW = hexPoints(R - 9);

const columnsFor = (n: number): number => Math.max(3, Math.min(7, Math.ceil(Math.sqrt(n * 1.6))));
const short = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

function cellCenter(i: number, cols: number): { x: number; y: number } {
  const row = Math.floor(i / cols);
  const col = i % cols;
  return { x: PAD + W / 2 + col * W + (row % 2 ? W / 2 : 0), y: PAD + R + row * ROW_H };
}

/** True while the document is visible (not minimised, not in a background window state). */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const on = (): void => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = (): void => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

export function LivingHive({
  agents: given,
  selectedId,
  onSelect,
  active,
}: {
  agents: AgentView[];
  selectedId: string | null;
  onSelect: (runId: string) => void;
  /** The Living hive tab is the one showing. */
  active: boolean;
}) {
  // A stable order (by start time): cells never jump when a run finishes, new ones join at the end, and
  // keyboard focus stays on the cell the user is on.
  const agents = useMemo(() => [...given].sort((a, b) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId)), [given]);
  const visible = useDocumentVisible();
  const reduced = useReducedMotion();
  const animating = active && visible && !reduced;
  const [focusIndex, setFocusIndex] = useState(0);
  const cellRefs = useRef<Array<SVGGElement | null>>([]);
  /** Cells seen before: only new ones fade in. */
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!agents.some((a) => !seen.has(a.runId))) return;
    // After the fade-in has played, mark them seen so a later re-render doesn't replay it.
    const id = setTimeout(() => setSeen((s) => new Set([...s, ...agents.map((a) => a.runId)])), 700);
    return () => clearTimeout(id);
  }, [agents, seen]);

  const n = agents.length;
  const cols = columnsFor(Math.max(n, 6));
  const rows = Math.max(1, Math.ceil(Math.max(n, 1) / cols));
  const width = PAD * 2 + cols * W + (rows > 1 ? W / 2 : 0);
  const height = PAD * 2 + 2 * R + (rows - 1) * ROW_H;
  const current = Math.min(focusIndex, Math.max(0, n - 1));

  const move = (to: number): void => {
    if (n === 0) return;
    const next = Math.max(0, Math.min(n - 1, to));
    setFocusIndex(next);
    cellRefs.current[next]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<SVGGElement>, i: number): void => {
    const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
    if (e.key in step) {
      e.preventDefault();
      move(i + step[e.key]!);
    } else if (e.key === 'Home') {
      e.preventDefault();
      move(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      move(n - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const a = agents[i];
      if (a) onSelect(a.runId);
    }
  };

  if (n === 0) {
    // A few empty comb cells: the hive is ready, nobody is in it yet.
    const empty = 5;
    const ew = PAD * 2 + 3 * W + W / 2;
    const eh = PAD * 2 + 2 * R + ROW_H;
    return (
      <div className="living-hive flex flex-col items-center gap-3 p-6" data-animating="false" data-testid="living-hive">
        <svg aria-hidden="true" className="w-full max-w-[360px]" viewBox={`0 0 ${ew} ${eh}`}>
          {Array.from({ length: empty }, (_, i) => {
            const { x, y } = cellCenter(i, 3);
            return <polygon fill="var(--surface)" key={i} points={HEX} stroke="var(--line)" strokeDasharray="5 5" strokeWidth={2} transform={`translate(${x} ${y})`} />;
          })}
        </svg>
        <p className="m-0 text-sm text-muted">No agents yet. Give the Queen a goal.</p>
      </div>
    );
  }

  return (
    <div className="living-hive flex min-w-0 flex-col gap-2" data-animating={animating ? 'true' : 'false'} data-testid="living-hive">
      <svg
        aria-label={`Living hive: ${n} agent${n === 1 ? '' : 's'}. Use the arrow keys to move between them and Enter to see one.`}
        className="w-full"
        role="group"
        // Never larger than its natural size: a handful of agents stays a small comb, not giant cells.
        style={{ maxHeight: 560, maxWidth: width }}
        viewBox={`0 0 ${width} ${height}`}
      >
        {agents.map((a, i) => {
          const { x, y } = cellCenter(i, cols);
          const Icon = roleIcon(a);
          const StatusIcon = STATUS_ICON[a.status];
          const selected = a.runId === selectedId;
          const name = agentName(a);
          const label = `${name}, ${LANE_LABEL[a.status]}: ${a.title}`;
          const isNew = !seen.has(a.runId);
          return (
            <g
              aria-label={label}
              aria-pressed={selected}
              className={cn('hive-cell cursor-pointer outline-none', isNew && 'hive-cell-enter')}
              data-role={a.role === 'insect' ? (a.caste ?? 'insect') : a.role}
              data-run={a.runId}
              data-status={a.status}
              data-testid="hive-cell"
              key={a.runId}
              onClick={() => {
                setFocusIndex(i);
                onSelect(a.runId);
              }}
              onFocus={() => setFocusIndex(i)}
              onKeyDown={(e) => onKeyDown(e, i)}
              ref={(el) => {
                cellRefs.current[i] = el;
              }}
              role="button"
              tabIndex={i === current ? 0 : -1}
              transform={`translate(${x} ${y})`}
            >
              <title>{label}</title>
              <polygon
                className="hive-cell-shape"
                fill={selected ? 'var(--active)' : 'var(--surface)'}
                points={HEX}
                stroke={STROKE[a.status]}
                strokeWidth={selected ? 3.5 : 2}
              />
              {a.status === 'working' ? <polygon className="hive-cell-glow" fill={STROKE.working} points={GLOW} /> : null}
              <Icon aria-hidden="true" color="var(--honey-text)" height={18} width={18} x={-9} y={-40} />
              {/*
                Each line ends in a space (not drawn: SVG drops trailing spaces) so the words read apart when the
                cell's text is taken as one string, as tools checking label-in-name (WCAG 2.5.3) do.
              */}
              <text fill="var(--text)" fontSize={12} fontWeight={600} textAnchor="middle" y={-5}>
                {short(roleLabel(a), 13)}{' '}
              </text>
              {a.agentId && a.agentId.toLowerCase() !== roleLabel(a).toLowerCase() ? (
                <text fill="var(--muted)" fontSize={10} textAnchor="middle" y={9}>
                  {short(a.agentId, 14)}{' '}
                </text>
              ) : null}
              <g transform="translate(0 28)">
                <StatusIcon aria-hidden="true" color="var(--text)" height={12} width={12} x={-34} y={-9} />
                <text fill="var(--muted)" fontSize={10.5} textAnchor="start" x={-19}>
                  {LANE_LABEL[a.status]}
                </text>
              </g>
            </g>
          );
        })}
      </svg>
      <p className="m-0 text-xs text-muted">
        Each cell is one agent run; the outline colour repeats its status, which is always written in the cell. Motion pauses when this
        view is hidden and stays off if your system asks for reduced motion.
      </p>
    </div>
  );
}
