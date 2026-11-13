/**
 * A small force layout for the Brain graph (Phase 2 B5; custom by design, App 07). No dependency:
 * nodes push each other apart, links pull their ends together, and a gentle pull keeps everything near
 * the middle. It is deterministic: the same records and links always give the same picture, so a
 * refresh after an edit doesn't reshuffle the graph.
 */
export interface LayoutNode {
  id: string;
  /** Drawn radius; bigger nodes keep more room around them. */
  r: number;
}
export interface LayoutEdge {
  from: string;
  to: string;
}
export interface Point {
  x: number;
  y: number;
}

/** A stable number in [0, 1) from a string (FNV-1a), for starting positions. */
function unit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Positions for every node, centred on (0, 0). `iterations` trades speed for tidiness; 400 nodes and
 * 240 iterations take well under 100 ms.
 */
export function forceLayout(nodes: LayoutNode[], edges: LayoutEdge[], iterations = 240): Map<string, Point> {
  const n = nodes.length;
  const out = new Map<string, Point>();
  if (n === 0) return out;
  if (n === 1) {
    out.set(nodes[0]!.id, { x: 0, y: 0 });
    return out;
  }

  const index = new Map(nodes.map((nd, i) => [nd.id, i]));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  // Start on a golden-angle spiral, ordered by a hash of the id (stable across filters).
  const order = nodes.map((nd, i) => ({ i, k: unit(nd.id) })).sort((a, b) => a.k - b.k);
  const spread = 26 * Math.sqrt(n);
  order.forEach(({ i }, rank) => {
    const a = rank * 2.399963229728653;
    const d = spread * Math.sqrt((rank + 0.5) / n);
    xs[i] = Math.cos(a) * d;
    ys[i] = Math.sin(a) * d;
  });

  const links: Array<[number, number]> = [];
  for (const e of edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a !== undefined && b !== undefined && a !== b) links.push([a, b]);
  }
  const degree = new Float64Array(n);
  for (const [a, b] of links) {
    degree[a]! += 1;
    degree[b]! += 1;
  }

  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  // Room for a title beside each node: labels are about 150 px wide at most.
  const REPEL = 5200;
  const SPRING = 0.04;
  const GRAVITY = 0.01;
  const LABEL_ROOM = 70;

  for (let it = 0; it < iterations; it++) {
    const cool = 1 - it / iterations;
    fx.fill(0);
    fy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = xs[i]! - xs[j]!;
        let dy = ys[i]! - ys[j]!;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          // Same spot: nudge apart in a fixed direction.
          dx = 0.1 * (i - j);
          dy = 0.1;
          d2 = dx * dx + dy * dy;
        }
        const room = nodes[i]!.r + nodes[j]!.r + LABEL_ROOM;
        const f = REPEL / d2 + (d2 < room * room ? 0.6 * (room - Math.sqrt(d2)) : 0);
        const d = Math.sqrt(d2);
        const ux = (dx / d) * f;
        const uy = (dy / d) * f;
        fx[i]! += ux;
        fy[i]! += uy;
        fx[j]! -= ux;
        fy[j]! -= uy;
      }
    }
    for (const [a, b] of links) {
      const dx = xs[b]! - xs[a]!;
      const dy = ys[b]! - ys[a]!;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const rest = 110 + nodes[a]!.r + nodes[b]!.r;
      const f = SPRING * (d - rest);
      const ux = (dx / d) * f;
      const uy = (dy / d) * f;
      fx[a]! += ux / Math.max(1, Math.sqrt(degree[a]!));
      fy[a]! += uy / Math.max(1, Math.sqrt(degree[a]!));
      fx[b]! -= ux / Math.max(1, Math.sqrt(degree[b]!));
      fy[b]! -= uy / Math.max(1, Math.sqrt(degree[b]!));
    }
    const maxStep = 24 * cool + 0.5;
    for (let i = 0; i < n; i++) {
      fx[i]! -= xs[i]! * GRAVITY;
      fy[i]! -= ys[i]! * GRAVITY;
      const m = Math.sqrt(fx[i]! * fx[i]! + fy[i]! * fy[i]!);
      const s = m > maxStep ? maxStep / m : 1;
      xs[i]! += fx[i]! * s;
      ys[i]! += fy[i]! * s;
    }
  }

  nodes.forEach((nd, i) => out.set(nd.id, { x: xs[i]!, y: ys[i]! }));
  return out;
}

/** The box around all points (with each node's radius), for fit-to-view. */
export function bounds(points: Map<string, Point>, radius: (id: string) => number): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [id, p] of points) {
    const r = radius(id);
    x0 = Math.min(x0, p.x - r);
    y0 = Math.min(y0, p.y - r);
    x1 = Math.max(x1, p.x + r);
    y1 = Math.max(y1, p.y + r);
  }
  if (!Number.isFinite(x0)) return { x: -100, y: -100, w: 200, h: 200 };
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}
