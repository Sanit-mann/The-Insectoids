/**
 * The Brain graph (Memory 01-D10, D13; App 07 Brain; Phase 2 B5). Custom by design (App 07: no match
 * in the preferred libraries): records are nodes, drawn by kind with their own shape AND colour (never
 * colour alone), sized by importance; unconfirmed or proposed records have a dashed outline, archived
 * ones are faded. Lines come only from real links. Filters by shelf, kind and date; pan, zoom, a
 * keyboard path through the nodes, and the same records as a plain list.
 *
 * Reuses: shadcn `button` (zoom controls), our connections `Switch` (include archived) and
 * `InlineError`. Custom: the graph itself and its layout (force-layout.ts).
 */
import { Brain, List, Maximize, Minus, Network, Plus, RefreshCw } from 'lucide-react';
import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { BrainGraphNode, BrainGraphRequest, BrainGraphView, RecordKind } from '@insectoids/shared';
import { InlineError } from '@/components/changes/CardChanges';
import { Switch } from '@/components/connections/Switch';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { type Point, bounds, forceLayout } from './force-layout';
import { KINDS, KIND_MARK, TRUST, kindInfo, shapePath } from './kinds';
import { useLive } from './useLive';

const VIEW_W = 900;
const VIEW_H = 560;
const MIN_K = 0.2;
const MAX_K = 4;
/** Titles drawn next to the most important nodes; the rest show theirs on hover or focus. */
const LABELLED = 10;
const DAY = 24 * 60 * 60_000;

type Scope = NonNullable<BrainGraphRequest['scope']>;
const SCOPES: Array<{ id: Scope; label: string }> = [
  { id: 'project', label: 'This project' },
  { id: 'global', label: 'Global' },
  { id: 'all', label: 'All' },
];
const DATES: Array<{ days: number; label: string }> = [
  { days: 0, label: 'Any time' },
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

interface Transform {
  x: number;
  y: number;
  k: number;
}

const radius = (n: BrainGraphNode): number => 7 + Math.min(1, Math.max(0, n.importance)) * 9;
/**
 * A title shortened for a node label. It cuts at a word boundary where it can, so the words shown are whole words of
 * the node's name ("label in name", WCAG 2.5.3: someone saying what they see can still pick it).
 */
const short = (s: string, max = 26): string => {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
};

/** A small mark for the legend and the list: the kind's shape in its colour. */
export function KindMark({ kind, dashed = false, size = 16 }: { kind: RecordKind; dashed?: boolean; size?: number }) {
  const m = KIND_MARK[kind];
  return (
    <svg aria-hidden="true" className="shrink-0" height={size} viewBox="-10 -10 20 20" width={size}>
      <path
        d={shapePath(m.shape, 6.5)}
        fill={m.color}
        fillOpacity={dashed ? 0.25 : 0.9}
        stroke={m.color}
        strokeDasharray={dashed ? '2.5 2' : undefined}
        strokeWidth={dashed ? 1.6 : 1}
      />
    </svg>
  );
}

/** The SVG keeps its aspect ratio ("meet"): one viewBox unit per `1/u` pixels, centred in the box. */
function geometry(box: { width: number; height: number }): { u: number; offX: number; offY: number } {
  const u = Math.max(VIEW_W / Math.max(1, box.width), VIEW_H / Math.max(1, box.height));
  return { u, offX: (box.width - VIEW_W / u) / 2, offY: (box.height - VIEW_H / u) / 2 };
}

function fit(points: Map<string, Point>, r: (id: string) => number): Transform {
  const b = bounds(points, r);
  // Titles sit to the right of their nodes: leave ~150 units for them on that side.
  const LABEL = 150;
  const k = Math.min(MAX_K, Math.max(MIN_K, Math.min(VIEW_W / (b.w + LABEL + 80), VIEW_H / (b.h + 80), 1.6)));
  return { k, x: VIEW_W / 2 - (b.x + (b.w + LABEL) / 2) * k, y: VIEW_H / 2 - (b.y + b.h / 2) * k };
}

export function GraphView({ openId, onOpen, refreshKey }: { openId: string | null; onOpen: (id: string) => void; refreshKey: number }) {
  const [scope, setScope] = useState<Scope>('project');
  const [kinds, setKinds] = useState<RecordKind[]>([]);
  const [days, setDays] = useState(0);
  const [archived, setArchived] = useState(false);
  const [asList, setAsList] = useState(false);
  // "since" is fixed when the date filter is picked, so the request (and the layout) stays stable.
  const [since, setSince] = useState<number | undefined>(undefined);

  const req: BrainGraphRequest = {
    scope,
    ...(kinds.length ? { kinds } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(archived ? { includeArchived: true } : {}),
  };
  const key = JSON.stringify([req, refreshKey]);
  const { live, reload } = useLive<BrainGraphView>(key, () => window.insectoids.hive.brainGraph(req));

  const toggleKind = (k: RecordKind): void => setKinds((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]));
  const pickDays = (d: number): void => {
    setDays(d);
    setSince(d ? Date.now() - d * DAY : undefined);
  };

  return (
    <section aria-label="Brain graph" className="flex min-w-0 flex-col gap-3" data-testid="brain-graph">
      <div className="flex flex-wrap items-center gap-3">
        <div aria-label="Which shelf" className="flex gap-1" role="group">
          {SCOPES.map((s) => (
            <button
              aria-pressed={scope === s.id}
              className={cn(
                'min-h-10 rounded-[10px] border px-3 text-sm',
                scope === s.id ? 'border-honey bg-active font-medium text-honey-text' : 'border-line text-muted hover:text-text',
              )}
              key={s.id}
              onClick={() => setScope(s.id)}
              type="button"
            >
              {s.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-muted">
          <span>Changed</span>
          <select
            className="min-h-10 rounded-[10px] border border-line bg-surface px-2 text-text focus-visible:outline-2 focus-visible:outline-honey"
            data-testid="graph-date"
            onChange={(e) => pickDays(Number(e.target.value))}
            value={days}
          >
            {DATES.map((d) => (
              <option key={d.days} value={d.days}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2">
          <Switch checked={archived} label="Include archived" onChange={setArchived} />
          <span className="text-xs text-muted">Include archived</span>
        </div>
        <Button aria-pressed={asList} className="ml-auto" data-testid="graph-list-toggle" onClick={() => setAsList((v) => !v)} size="sm" variant="outline">
          {asList ? <Network aria-hidden="true" /> : <List aria-hidden="true" />}
          {asList ? 'Show as graph' : 'Show as list'}
        </Button>
      </div>
      <div aria-label="Filter by kind" className="flex flex-wrap gap-1.5" role="group">
        {KINDS.map(({ kind, label }) => {
          const on = kinds.includes(kind);
          return (
            <button
              aria-pressed={on}
              className={cn('inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-xs', on ? 'border-honey text-honey-text' : 'border-line text-muted hover:text-text')}
              key={kind}
              onClick={() => toggleKind(kind)}
              type="button"
            >
              <KindMark kind={kind} size={12} />
              {label}
            </button>
          );
        })}
      </div>

      {live.state === 'loading' && <div aria-busy="true" className="h-[420px] animate-pulse rounded-2xl border border-line bg-surface" />}
      {live.state === 'error' && <InlineError message={`Could not draw the graph: ${live.message}`} onRetry={reload} />}
      {live.state === 'ready' && (
        <GraphBody asList={asList} graph={live.data} onOpen={onOpen} openId={openId} refreshing={live.refreshing} onReload={reload} />
      )}
    </section>
  );
}

function GraphBody({
  graph,
  openId,
  onOpen,
  asList,
  refreshing,
  onReload,
}: {
  graph: BrainGraphView;
  openId: string | null;
  onOpen: (id: string) => void;
  asList: boolean;
  refreshing: boolean;
  onReload: () => void;
}) {
  const { nodes, edges, hidden } = graph;
  const counts = (
    <p aria-live="polite" className="m-0 flex flex-wrap items-center gap-2 text-xs text-muted" data-testid="graph-count">
      <span>
        {nodes.length} {nodes.length === 1 ? 'record' : 'records'} · {edges.length} {edges.length === 1 ? 'link' : 'links'}
      </span>
      {hidden > 0 && <span data-testid="graph-hidden">· {hidden} more not shown (the most important come first)</span>}
      {refreshing && <RefreshCw aria-label="Updating" className="size-3.5 animate-spin motion-reduce:animate-none" />}
      <button className="min-h-8 rounded-md px-2 font-medium text-honey-text hover:underline" onClick={onReload} type="button">
        Refresh
      </button>
    </p>
  );

  if (nodes.length === 0) {
    return (
      <>
        {counts}
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line p-10 text-center text-muted" data-testid="graph-empty">
          <Brain aria-hidden="true" className="text-honey" size={36} strokeWidth={1.5} />
          <p className="m-0 max-w-[420px]">Nothing in the Brain matches these filters.</p>
        </div>
      </>
    );
  }

  return (
    <>
      {counts}
      {asList ? <GraphList edges={edges} nodes={nodes} onOpen={onOpen} openId={openId} /> : <GraphCanvas edges={edges} nodes={nodes} onOpen={onOpen} openId={openId} />}
      <Legend />
    </>
  );
}

function Legend() {
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border border-line px-3 py-2 text-xs text-muted" data-testid="graph-legend">
      <ul aria-label="Kinds" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
        {KINDS.map(({ kind, label }) => (
          <li className="inline-flex items-center gap-1.5" key={kind}>
            <KindMark kind={kind} />
            <span className="text-text">{label}</span>
          </li>
        ))}
      </ul>
      <p className="m-0">
        Bigger: more important. Solid: confirmed. Dashed outline: waiting for you to confirm. Faded: archived. Lines are real links; hover or focus
        a record to see what they mean.
      </p>
    </div>
  );
}

function GraphList({ nodes, edges, openId, onOpen }: { nodes: BrainGraphNode[]; edges: BrainGraphView['edges']; openId: string | null; onOpen: (id: string) => void }) {
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of edges) {
      d.set(e.from, (d.get(e.from) ?? 0) + 1);
      d.set(e.to, (d.get(e.to) ?? 0) + 1);
    }
    return d;
  }, [edges]);
  return (
    <ul aria-label="Records in the graph" className="m-0 flex list-none flex-col gap-1 p-0" data-testid="graph-list">
      {nodes.map((n) => {
        const links = degree.get(n.id) ?? 0;
        return (
          <li key={n.id}>
            <button
              aria-current={openId === n.id ? 'true' : undefined}
              className={cn('flex min-h-10 w-full items-center gap-2.5 rounded-[10px] border border-transparent px-3 py-1.5 text-left hover:bg-surface-2', openId === n.id && 'border-line bg-active', n.archived && 'opacity-70')}
              data-id={n.id}
              data-testid="graph-list-item"
              onClick={() => onOpen(n.id)}
              type="button"
            >
              <KindMark dashed={n.trust !== 'confirmed'} kind={n.kind} />
              <span className="min-w-0 flex-1 truncate">{n.title}</span>
              <span className="shrink-0 text-xs text-muted">
                {kindInfo(n.kind).label} · {TRUST[n.trust].label}
                {n.archived ? ' · archived' : ''} · {links} {links === 1 ? 'link' : 'links'}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function GraphCanvas({ nodes, edges, openId, onOpen }: { nodes: BrainGraphNode[]; edges: BrainGraphView['edges']; openId: string | null; onOpen: (id: string) => void }) {
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const r = useMemo(() => (id: string) => radius(byId.get(id) ?? nodes[0]!), [byId, nodes]);
  const points = useMemo(() => forceLayout(nodes.map((n) => ({ id: n.id, r: radius(n) })), edges), [nodes, edges]);
  const layoutKey = useMemo(() => nodes.map((n) => n.id).join('|') + '/' + edges.length, [nodes, edges]);
  const [view, setView] = useState<{ key: string; t: Transform } | null>(null);
  const t = view?.key === layoutKey ? view.t : fit(points, r);
  const setT = (next: Transform | ((cur: Transform) => Transform)): void =>
    setView((v) => {
      const cur = v?.key === layoutKey ? v.t : fit(points, r);
      return { key: layoutKey, t: typeof next === 'function' ? next(cur) : next };
    });

  const [hot, setHot] = useState<string | null>(null);
  // Roving focus: one node is in the tab order; arrow keys walk the rest (most important first).
  const [active, setActive] = useState(0);
  const activeIndex = Math.min(active, nodes.length - 1);
  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ x: number; y: number; t: Transform; id: number } | null>(null);

  const labelled = useMemo(() => new Set(nodes.slice(0, LABELLED).map((n) => n.id)), [nodes]);
  const linkedToHot = useMemo(() => {
    const s = new Set<string>();
    if (!hot) return s;
    for (const e of edges) {
      if (e.from === hot) s.add(e.to);
      if (e.to === hot) s.add(e.from);
    }
    return s;
  }, [edges, hot]);

  /** Screen pixels → viewBox units. */
  const unit = (): number => {
    const box = svgRef.current?.getBoundingClientRect();
    return box ? geometry(box).u : 1;
  };
  const zoomAt = (factor: number, at: Point = { x: VIEW_W / 2, y: VIEW_H / 2 }): void =>
    setT((cur) => {
      const k = Math.min(MAX_K, Math.max(MIN_K, cur.k * factor));
      const s = k / cur.k;
      return { k, x: at.x - (at.x - cur.x) * s, y: at.y - (at.y - cur.y) * s };
    });

  // Wheel zoom needs a non-passive listener so the page doesn't scroll at the same time.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const box = svg.getBoundingClientRect();
      const { u, offX, offY } = geometry(box);
      const at = { x: (e.clientX - box.left - offX) * u, y: (e.clientY - box.top - offY) * u };
      const factor = Math.exp(-e.deltaY * 0.0015);
      setView((v) => {
        const cur = v?.key === layoutKey ? v.t : fit(points, r);
        const k = Math.min(MAX_K, Math.max(MIN_K, cur.k * factor));
        const s = k / cur.k;
        return { key: layoutKey, t: { k, x: at.x - (at.x - cur.x) * s, y: at.y - (at.y - cur.y) * s } };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [layoutKey, points, r]);

  const onPointerDown = (e: PointerEvent<SVGRectElement>): void => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, t, id: e.pointerId };
  };
  const onPointerMove = (e: PointerEvent<SVGRectElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const u = unit();
    setT({ ...d.t, x: d.t.x + (e.clientX - d.x) * u, y: d.t.y + (e.clientY - d.y) * u });
  };
  const onPointerUp = (e: PointerEvent<SVGRectElement>): void => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };

  const focusNode = (i: number): void => {
    const n = nodes[(i + nodes.length) % nodes.length];
    if (!n) return;
    setActive((i + nodes.length) % nodes.length);
    nodeRefs.current.get(n.id)?.focus();
  };
  const onNodeKey = (e: KeyboardEvent<SVGGElement>, i: number, id: string): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(id);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      focusNode(i + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusNode(i - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusNode(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusNode(nodes.length - 1);
    }
  };

  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-surface">
      <svg
        aria-describedby="graph-help"
        aria-label={`Brain graph: ${nodes.length} records and ${edges.length} links`}
        className="block h-[min(62vh,560px)] min-h-[360px] w-full touch-none select-none"
        ref={svgRef}
        role="group"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      >
        <rect
          className="cursor-grab active:cursor-grabbing"
          fill="transparent"
          height={VIEW_H}
          onPointerCancel={onPointerUp}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          width={VIEW_W}
        />
        <g transform={`translate(${t.x} ${t.y}) scale(${t.k})`}>
          <g aria-hidden="true">
            {edges.map((e) => {
              const a = points.get(e.from);
              const b = points.get(e.to);
              if (!a || !b) return null;
              const lit = hot !== null && (e.from === hot || e.to === hot);
              return (
                <g data-from={e.from} data-rel={e.rel} data-testid="graph-edge" data-to={e.to} key={`${e.from}-${e.rel}-${e.to}`}>
                  <line
                    stroke={lit ? 'var(--honey)' : 'var(--muted)'}
                    strokeOpacity={lit ? 0.95 : hot ? 0.18 : 0.45}
                    strokeWidth={(lit ? 2 : 1.25) / t.k}
                    x1={a.x}
                    x2={b.x}
                    y1={a.y}
                    y2={b.y}
                  >
                    <title>{e.rel.replace(/_/g, ' ')}</title>
                  </line>
                  {lit && (
                    <text
                      className="pointer-events-none"
                      fill="var(--text)"
                      fontSize={11 / t.k}
                      paintOrder="stroke"
                      stroke="var(--surface)"
                      strokeWidth={3 / t.k}
                      textAnchor="middle"
                      x={(a.x + b.x) / 2}
                      y={(a.y + b.y) / 2 - 4 / t.k}
                    >
                      {e.rel.replace(/_/g, ' ')}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
          {nodes.map((n, i) => {
            const p = points.get(n.id);
            if (!p) return null;
            const m = KIND_MARK[n.kind];
            const rad = radius(n);
            const dashed = n.trust !== 'confirmed';
            const open = openId === n.id;
            const dim = hot !== null && hot !== n.id && !linkedToHot.has(n.id);
            const showLabel = labelled.has(n.id) || hot === n.id || open || linkedToHot.has(n.id);
            const label = `${kindInfo(n.kind).label}: ${n.title}. ${TRUST[n.trust].label}${n.archived ? ', archived' : ''}.`;
            return (
              <g
                aria-current={open ? 'true' : undefined}
                aria-label={label}
                className="group cursor-pointer outline-none"
                data-id={n.id}
                data-kind={n.kind}
                data-testid="graph-node"
                key={n.id}
                onBlur={() => setHot((h) => (h === n.id ? null : h))}
                onClick={() => {
                  setActive(i);
                  onOpen(n.id);
                }}
                onFocus={() => {
                  setActive(i);
                  setHot(n.id);
                }}
                onKeyDown={(e) => onNodeKey(e, i, n.id)}
                onPointerEnter={() => setHot(n.id)}
                onPointerLeave={() => setHot((h) => (h === n.id ? null : h))}
                opacity={n.archived ? 0.45 : dim ? 0.35 : 1}
                ref={(el) => {
                  if (el) nodeRefs.current.set(n.id, el);
                  else nodeRefs.current.delete(n.id);
                }}
                role="button"
                tabIndex={i === activeIndex ? 0 : -1}
                transform={`translate(${p.x} ${p.y})`}
              >
                {/* Bigger invisible hit area than the mark. */}
                <circle fill="transparent" r={Math.max(rad + 6, 14)} />
                <circle
                  className={cn('opacity-0 group-focus-visible:opacity-100', open && 'opacity-100')}
                  fill="none"
                  r={rad + 6}
                  stroke="var(--honey)"
                  strokeWidth={2.5}
                />
                <path
                  d={shapePath(m.shape, rad)}
                  fill={m.color}
                  fillOpacity={dashed ? 0.22 : 0.9}
                  stroke={m.color}
                  strokeDasharray={dashed ? '4 3' : undefined}
                  strokeWidth={dashed ? 2 : 1.5}
                />
                {showLabel && (
                  <text
                    className="pointer-events-none"
                    fill="var(--text)"
                    fontSize={12 / Math.max(1, t.k)}
                    paintOrder="stroke"
                    stroke="var(--surface)"
                    strokeLinejoin="round"
                    strokeWidth={3.5 / Math.max(1, t.k)}
                    x={rad + 6}
                    y={4}
                  >
                    {short(n.title)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <p className="sr-only" id="graph-help">
        Tab to the graph, then use the arrow keys to move between records, most important first. Enter opens a record.
      </p>
      <div aria-label="Zoom" className="absolute right-2 top-2 flex flex-col gap-1" role="group">
        <Button aria-label="Zoom in" onClick={() => zoomAt(1.25)} size="icon" variant="outline">
          <Plus aria-hidden="true" />
        </Button>
        <Button aria-label="Zoom out" onClick={() => zoomAt(0.8)} size="icon" variant="outline">
          <Minus aria-hidden="true" />
        </Button>
        <Button aria-label="Fit the whole graph" data-testid="graph-fit" onClick={() => setView(null)} size="icon" variant="outline">
          <Maximize aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
