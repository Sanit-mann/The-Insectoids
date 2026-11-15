/**
 * Pure helpers for the Brain globe (Phase 4 A2, Memory 01-D13 phase 2). No Three.js and no DOM here, so they
 * stay easy to test: where records sit on the sphere, how big they are, the arcs between them, and a
 * cheap frame-time meter.
 */

export type Vec3 = readonly [number, number, number];

/** What the layout needs from a record. */
export interface GlobeNodeLike {
  id: string;
  kind: string;
  importance: number;
}

/**
 * The order records are placed in: by kind (in `kindOrder`), then most important first, then by id so the
 * layout is stable. Consecutive points on a Fibonacci sphere sit next to each other, so each kind ends up
 * as its own band around the globe.
 */
export function orderForGlobe<T extends GlobeNodeLike>(nodes: readonly T[], kindOrder: readonly string[]): T[] {
  const rank = new Map(kindOrder.map((k, i) => [k, i]));
  const kindRank = (k: string): number => rank.get(k) ?? kindOrder.length;
  return [...nodes].sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || b.importance - a.importance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** The i-th of n points spread evenly over a sphere of `radius` (a Fibonacci sphere), from the top down. */
export function fibonacciPoint(i: number, n: number, radius = 1): Vec3 {
  if (n <= 1) return [0, radius, 0];
  const y = 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const a = GOLDEN_ANGLE * i;
  return [Math.cos(a) * r * radius, y * radius, Math.sin(a) * r * radius];
}

/** All n points as one flat array (x, y, z, x, y, z, ...). */
export function fibonacciSphere(n: number, radius = 1): Float32Array {
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = fibonacciPoint(i, n, radius);
    out[i * 3] = p[0];
    out[i * 3 + 1] = p[1];
    out[i * 3 + 2] = p[2];
  }
  return out;
}

/**
 * A node's radius on a unit globe: bigger for more important records, and smaller when there are many,
 * so neighbours (about `sqrt(4π / n)` apart) never overlap.
 */
export function nodeRadius(importance: number, count: number): number {
  const spacing = Math.min(0.2, Math.sqrt((4 * Math.PI) / Math.max(1, count)));
  const imp = Math.min(1, Math.max(0, importance));
  return spacing * (0.12 + 0.24 * imp);
}

/** Arc segments per link: fewer when there are many links, so 5,000 of them stay cheap. */
export function arcSegmentsFor(edgeCount: number): number {
  if (edgeCount > 3000) return 4;
  if (edgeCount > 800) return 6;
  return 10;
}

/**
 * Points along the great circle from `a` to `b` (both on the unit sphere), lifted off the surface in the
 * middle so the arc clears the globe. Returns `segments + 1` points as a flat array.
 */
export function greatCircleArc(a: Vec3, b: Vec3, segments: number, radius = 1): Float32Array {
  const out = new Float32Array((segments + 1) * 3);
  writeArc(out, 0, a, b, segments, radius);
  return out;
}

/** Writes the arc's `segments + 1` points into `out` starting at float `offset`. */
function writeArc(out: Float32Array, offset: number, a: Vec3, b: Vec3, segments: number, radius: number): void {
  const la = Math.hypot(a[0], a[1], a[2]) || 1;
  const lb = Math.hypot(b[0], b[1], b[2]) || 1;
  const ax = a[0] / la, ay = a[1] / la, az = a[2] / la;
  const bx = b[0] / lb, by = b[1] / lb, bz = b[2] / lb;
  const dot = Math.min(1, Math.max(-1, ax * bx + ay * by + az * bz));
  const angle = Math.acos(dot);
  const sin = Math.sin(angle);
  // Nearly opposite points: go round through a perpendicular so the arc is still a circle.
  let px = 0, py = 0, pz = 0;
  const opposite = sin < 1e-5 && dot < 0;
  if (opposite) {
    // Any unit vector at right angles to a.
    const ref: Vec3 = Math.abs(ay) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    px = ay * ref[2] - az * ref[1];
    py = az * ref[0] - ax * ref[2];
    pz = ax * ref[1] - ay * ref[0];
    const lp = Math.hypot(px, py, pz) || 1;
    px /= lp;
    py /= lp;
    pz /= lp;
  }
  // Low arcs hug the globe, so links read as threads on its surface rather than a web around it.
  const lift = 0.015 + 0.08 * (angle / Math.PI);
  for (let s = 0; s <= segments; s++) {
    const t = s / segments;
    let x: number, y: number, z: number;
    if (opposite) {
      // a → p → -a, half a turn.
      const th = Math.PI * t;
      x = ax * Math.cos(th) + px * Math.sin(th);
      y = ay * Math.cos(th) + py * Math.sin(th);
      z = az * Math.cos(th) + pz * Math.sin(th);
    } else if (sin < 1e-5) {
      x = ax;
      y = ay;
      z = az;
    } else {
      const wa = Math.sin((1 - t) * angle) / sin;
      const wb = Math.sin(t * angle) / sin;
      x = ax * wa + bx * wb;
      y = ay * wa + by * wb;
      z = az * wa + bz * wb;
    }
    const r = radius * (1 + lift * Math.sin(Math.PI * t));
    out[offset + s * 3] = x * r;
    out[offset + s * 3 + 1] = y * r;
    out[offset + s * 3 + 2] = z * r;
  }
}

/**
 * All links as line-segment pairs for one `LineSegments` geometry: each arc of `segments` pieces gives
 * `segments * 2` vertices. `positions` is the flat node array; `pairs` holds node indices (from, to).
 */
export function arcSegmentPositions(positions: Float32Array, pairs: ReadonlyArray<readonly [number, number]>, segments: number, radius = 1): Float32Array {
  const out = new Float32Array(pairs.length * segments * 2 * 3);
  const arc = new Float32Array((segments + 1) * 3);
  let o = 0;
  for (const [i, j] of pairs) {
    const a: Vec3 = [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
    const b: Vec3 = [positions[j * 3]!, positions[j * 3 + 1]!, positions[j * 3 + 2]!];
    writeArc(arc, 0, a, b, segments, radius);
    for (let s = 0; s < segments; s++) {
      for (let k = 0; k < 6; k++) out[o + k] = arc[s * 3 + k]!;
      o += 6;
    }
  }
  return out;
}

/** Links whose two ends are both on the globe (and not a record linked to itself), as index pairs. */
export function edgePairs(ids: readonly string[], edges: ReadonlyArray<{ from: string; to: string }>): Array<[number, number]> {
  const index = new Map(ids.map((id, i) => [id, i]));
  const pairs: Array<[number, number]> = [];
  for (const e of edges) {
    const i = index.get(e.from);
    const j = index.get(e.to);
    if (i === undefined || j === undefined || i === j) continue;
    pairs.push([i, j]);
  }
  return pairs;
}

/** The canvas summary for screen readers. */
export function globeSummary(nodes: number, links: number): string {
  return `Brain globe: ${nodes} ${nodes === 1 ? 'record' : 'records'}, ${links} ${links === 1 ? 'link' : 'links'}. Use the list for details.`;
}

/** Average time between the last `size` frames, in ms. O(1) per frame. */
export class FrameMeter {
  private readonly times: Float64Array;
  private next = 0;
  private count = 0;
  private sum = 0;

  constructor(size = 60) {
    this.times = new Float64Array(size);
  }

  push(ms: number): void {
    if (this.count === this.times.length) this.sum -= this.times[this.next]!;
    else this.count++;
    this.times[this.next] = ms;
    this.sum += ms;
    this.next = (this.next + 1) % this.times.length;
  }

  average(): number {
    return this.count ? this.sum / this.count : 0;
  }
}
