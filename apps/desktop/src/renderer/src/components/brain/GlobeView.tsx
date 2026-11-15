/**
 * The Brain globe (Phase 4 A2, Memory 01-D13 phase 2, "AIS-OS style"): up to 5,000 records on a sphere,
 * grouped so each kind forms its own band, sized by importance, coloured by kind (the `--kind-n` tokens of
 * the current theme), archived ones faded; links are arcs over the surface. Drag to turn, wheel or pinch
 * to zoom, a slow spin until you touch it (none with reduced motion). Hover shows a title, a click opens
 * the record. The same records are always listed beside it, grouped by kind: that list is the accessible
 * way in, and the only one when WebGL can't start.
 *
 * Libraries: Three.js (`three` core + OrbitControls add-on, in globe-scene.ts). Reuses the 2D graph's
 * filters (GraphFilters: our connections `Switch`), `InlineError`, and lucide icons. Custom: the scene and
 * its layout (globe-layout.ts).
 */
import { Brain, Globe, RefreshCw } from 'lucide-react';
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { BrainGraphNode, BrainGraphView, RecordKind } from '@insectoids/shared';
import { InlineError } from '@/components/changes/CardChanges';
import { cn } from '@/lib/utils';
import { GraphFilters, KindMark, useGraphFilters } from './GraphFilters';
import { edgePairs, orderForGlobe } from './globe-layout';
import { type GlobePalette, GlobeScene, webglAvailable } from './globe-scene';
import { KINDS, KIND_MARK, TRUST, kindInfo } from './kinds';
import { useLive } from './useLive';

/** The globe asks for many more records than the 2D graph (200). */
const GLOBE_LIMIT = 5000;
/** Records listed per kind before "Show all": keeps the page light with thousands of records. */
const LIST_CAP = 150;
const KIND_ORDER = KINDS.map((k) => k.kind);

/** Theme colours from the CSS tokens, read where the globe is (so dark and light both work). */
function readPalette(el: HTMLElement): GlobePalette {
  const cs = getComputedStyle(el);
  const token = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
  const kinds: Record<string, string> = {};
  for (const { kind } of KINDS) {
    const name = /var\((--[\w-]+)\)/.exec(KIND_MARK[kind].color)?.[1];
    kinds[kind] = name ? token(name, '#888888') : '#888888';
  }
  return {
    kinds,
    edge: token('--muted', '#a8a08f'),
    highlight: token('--honey', '#f2a93b'),
    sphere: token('--surface-2', '#1e1b15'),
    grid: token('--line', '#2a261e'),
    fade: token('--surface', '#17150f'),
  };
}

const shelfLabel = (shelf: string): string => (shelf === 'global' ? 'Global shelf' : `${shelf} shelf`);

export function GlobeView({ openId, onOpen, refreshKey }: { openId: string | null; onOpen: (id: string) => void; refreshKey: number }) {
  const f = useGraphFilters();
  const req = { ...f.req, limit: GLOBE_LIMIT };
  const key = JSON.stringify([req, refreshKey]);
  const { live, reload } = useLive<BrainGraphView>(key, () => window.insectoids.hive.brainGraph(req));

  return (
    <section aria-label="Brain globe" className="flex min-w-0 flex-col gap-3" data-testid="globe-panel">
      <GraphFilters dateTestId="globe-date" f={f} />
      {live.state === 'loading' && <div aria-busy="true" className="h-[420px] animate-pulse rounded-2xl border border-line bg-surface" />}
      {live.state === 'error' && <InlineError message={`Could not draw the globe: ${live.message}`} onRetry={reload} />}
      {live.state === 'ready' && <GlobeBody graph={live.data} onOpen={onOpen} onReload={reload} openId={openId} refreshing={live.refreshing} />}
    </section>
  );
}

function GlobeBody({
  graph,
  openId,
  onOpen,
  refreshing,
  onReload,
}: {
  graph: BrainGraphView;
  openId: string | null;
  onOpen: (id: string) => void;
  refreshing: boolean;
  onReload: () => void;
}) {
  const [webgl] = useState(webglAvailable);
  const [failed, setFailed] = useState(false);
  const nodes = useMemo(() => orderForGlobe(graph.nodes, KIND_ORDER), [graph.nodes]);
  const links = useMemo(
    () =>
      edgePairs(
        graph.nodes.map((n) => n.id),
        graph.edges,
      ).length,
    [graph.nodes, graph.edges],
  );
  // A pick from the list turns the globe to face the record; a click on the globe doesn't need to.
  const faceNextRef = useRef(false);
  const fromList = (id: string): void => {
    faceNextRef.current = true;
    onOpen(id);
  };
  const total = nodes.length + graph.hidden;

  const counts = (
    <p aria-live="polite" className="m-0 flex flex-wrap items-center gap-2 text-xs text-muted" data-testid="globe-count">
      <span>
        Showing {nodes.length} of {total} {total === 1 ? 'record' : 'records'} · {links} {links === 1 ? 'link' : 'links'}
      </span>
      {graph.hidden > 0 && <span data-testid="globe-hidden">· {graph.hidden} more not shown (the most important come first)</span>}
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
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line p-10 text-center text-muted" data-testid="globe-empty">
          <Brain aria-hidden="true" className="text-honey" size={36} strokeWidth={1.5} />
          <p className="m-0 max-w-[420px]">Nothing in the Brain matches these filters.</p>
        </div>
      </>
    );
  }

  return (
    <>
      {counts}
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[999_1_420px] flex-col gap-2">
          {webgl && !failed ? (
            <GlobeCanvas edges={graph.edges} faceNextRef={faceNextRef} links={links} nodes={nodes} onFail={() => setFailed(true)} onOpen={onOpen} openId={openId} />
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line p-10 text-center text-muted" data-testid="globe-no-webgl">
              <Globe aria-hidden="true" className="text-honey" size={36} strokeWidth={1.5} />
              <p className="m-0 max-w-[420px]">
                The globe needs 3D graphics (WebGL), which aren&apos;t available on this computer right now. Every record is in the list.
              </p>
            </div>
          )}
          <Legend />
        </div>
        <GlobeList nodes={nodes} onPick={fromList} openId={openId} />
      </div>
    </>
  );
}

function Legend() {
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border border-line px-3 py-2 text-xs text-muted" data-testid="globe-legend">
      <ul aria-label="Kinds" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
        {KINDS.map(({ kind, label }) => (
          <li className="inline-flex items-center gap-1.5" key={kind}>
            <KindMark kind={kind} />
            <span className="text-text">{label}</span>
          </li>
        ))}
      </ul>
      <p className="m-0">
        Each kind has its own band and colour. Bigger: more important. Faded: archived. Lines are real links. A ring marks the open record. Drag to
        turn, scroll or pinch to zoom, click a record to open it.
      </p>
    </div>
  );
}

function GlobeCanvas({
  nodes,
  edges,
  links,
  openId,
  onOpen,
  onFail,
  faceNextRef,
}: {
  nodes: BrainGraphNode[];
  edges: BrainGraphView['edges'];
  links: number;
  openId: string | null;
  onOpen: (id: string) => void;
  onFail: () => void;
  faceNextRef: { current: boolean };
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<GlobeScene | null>(null);
  const helpId = useId();
  // The scene's callbacks read the latest props through refs, so it is built once per mount.
  const latest = useRef({ nodes, onOpen, onFail });
  useEffect(() => {
    latest.current = { nodes, onOpen, onFail };
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const showTip = (index: number | null, x: number, y: number): void => {
      const tip = tipRef.current;
      if (!tip) return;
      const n = index === null ? undefined : latest.current.nodes[index];
      if (!n) {
        tip.hidden = true;
        return;
      }
      const [title, meta] = tip.children;
      if (title) title.textContent = n.title;
      if (meta) meta.textContent = `${kindInfo(n.kind).label} · ${TRUST[n.trust].label}${n.archived ? ' · archived' : ''}`;
      tip.hidden = false;
      // Keep it inside the box: flip to the left/top near the right/bottom edges.
      const w = host.clientWidth;
      const h = host.clientHeight;
      const tx = x > w - 260 ? x - tip.offsetWidth - 12 : x + 14;
      const ty = y > h - 70 ? y - tip.offsetHeight - 10 : y + 14;
      tip.style.transform = `translate(${Math.max(4, tx)}px, ${Math.max(4, ty)}px)`;
    };
    let scene: GlobeScene;
    try {
      scene = new GlobeScene(
        host,
        {
          onHover: showTip,
          onPick: (i) => {
            const n = latest.current.nodes[i];
            if (n) latest.current.onOpen(n.id);
          },
        },
        {
          reducedMotion: motion.matches,
          describedBy: helpId,
          className: 'block h-full w-full touch-none select-none rounded-2xl outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-honey',
        },
      );
    } catch {
      latest.current.onFail();
      return;
    }
    sceneRef.current = scene;
    const onMotion = (): void => scene.setReducedMotion(motion.matches);
    motion.addEventListener('change', onMotion);
    // Theme switches change the tokens: recolour without rebuilding.
    const themeWatch = new MutationObserver(() => scene.setPalette(readPalette(host)));
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    return () => {
      themeWatch.disconnect();
      motion.removeEventListener('change', onMotion);
      sceneRef.current = null;
      scene.dispose();
    };
  }, [helpId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    sceneRef.current?.setData(nodes, edges, readPalette(host));
  }, [nodes, edges]);

  // After setData (declared after it, so it runs after it on new data too).
  useEffect(() => {
    const face = faceNextRef.current;
    faceNextRef.current = false;
    sceneRef.current?.setSelected(openId, face);
  }, [openId, nodes, faceNextRef]);

  return (
    <div
      className="relative h-[min(62vh,560px)] min-h-[360px] overflow-hidden rounded-2xl border border-line bg-surface"
      data-testid="brain-globe"
      ref={hostRef}
    >
      <p className="sr-only" id={helpId}>
        {nodes.length} records and {links} links. Arrow keys turn the globe, plus and minus zoom. The list beside the globe has every record and
        opens it.
      </p>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 left-0 z-10 flex max-w-[260px] flex-col gap-0.5 rounded-[10px] border border-line bg-surface px-3 py-2 text-sm text-text shadow-lg"
        data-testid="globe-tooltip"
        hidden
        ref={tipRef}
      >
        <span className="font-medium break-words" />
        <span className="text-xs text-muted" />
      </div>
    </div>
  );
}

/** The same records as the globe, grouped by kind, each a button that opens it (and turns the globe to it). */
function GlobeList({ nodes, openId, onPick }: { nodes: BrainGraphNode[]; openId: string | null; onPick: (id: string) => void }) {
  const groups = useMemo(() => {
    const by = new Map<RecordKind, BrainGraphNode[]>();
    for (const n of nodes) {
      const g = by.get(n.kind);
      if (g) g.push(n);
      else by.set(n.kind, [n]);
    }
    return KINDS.filter((k) => by.has(k.kind)).map((k) => ({ kind: k.kind, label: k.label, items: by.get(k.kind)! }));
  }, [nodes]);
  const [expanded, setExpanded] = useState<ReadonlySet<RecordKind>>(new Set());
  // A stable click handler, so the memoised rows don't all redraw when the selection changes.
  const pickRef = useRef(onPick);
  useEffect(() => {
    pickRef.current = onPick;
  });
  const [pick] = useState(() => (id: string) => pickRef.current(id));

  return (
    <nav aria-label="Records on the globe" className="flex max-h-[min(78vh,760px)] min-w-0 flex-[1_1_300px] flex-col gap-3 overflow-y-auto pr-1" data-testid="globe-list">
      {groups.map((g) => {
        const all = expanded.has(g.kind);
        const shown = all ? g.items : g.items.slice(0, LIST_CAP);
        // Keep the open record listed even when its group is cut off at the cap.
        const openHidden = !all && openId !== null && !shown.some((n) => n.id === openId) ? g.items.find((n) => n.id === openId) : undefined;
        const headingId = `globe-kind-${g.kind}`;
        return (
          <section aria-labelledby={headingId} className="flex flex-col gap-1" key={g.kind}>
            <h3 className="m-0 flex items-center gap-2 text-sm font-medium text-text" id={headingId}>
              <KindMark kind={g.kind} size={14} />
              {g.label} <span className="text-xs font-normal text-muted">({g.items.length})</span>
            </h3>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {shown.map((n) => (
                <GlobeListItem key={n.id} node={n} onPick={pick} open={openId === n.id} />
              ))}
              {openHidden && <GlobeListItem node={openHidden} onPick={pick} open />}
            </ul>
            {g.items.length > LIST_CAP && (
              <button
                className="min-h-8 self-start rounded-md px-2 text-xs font-medium text-honey-text hover:underline"
                onClick={() =>
                  setExpanded((s) => {
                    const next = new Set(s);
                    if (all) next.delete(g.kind);
                    else next.add(g.kind);
                    return next;
                  })
                }
                type="button"
              >
                {all ? `Show the first ${LIST_CAP}` : `Show all ${g.items.length} ${g.label.toLowerCase()} records`}
              </button>
            )}
          </section>
        );
      })}
    </nav>
  );
}

const GlobeListItem = memo(function GlobeListItem({ node: n, open, onPick }: { node: BrainGraphNode; open: boolean; onPick: (id: string) => void }) {
  return (
    <li>
      <button
        aria-current={open ? 'true' : undefined}
        className={cn(
          'flex min-h-10 w-full flex-col items-start rounded-[10px] border border-transparent px-3 py-1.5 text-left hover:bg-surface-2',
          open && 'border-honey bg-active',
          n.archived && 'opacity-70',
        )}
        data-id={n.id}
        data-testid="globe-list-item"
        onClick={() => onPick(n.id)}
        type="button"
      >
        <span className="w-full truncate text-sm text-text">{n.title}</span>
        <span className="text-xs text-muted">
          {kindInfo(n.kind).label} · {TRUST[n.trust].label} · {shelfLabel(n.shelf)}
          {n.archived ? ' · archived' : ''}
        </span>
      </button>
    </li>
  );
});
