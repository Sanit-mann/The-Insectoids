/**
 * Vector helpers for the Brain's meaning search: packing for SQLite BLOBs, brute-force cosine search
 * (fast enough far beyond Brain sizes, 01-R7), and Reciprocal Rank Fusion for hybrid ranking.
 */

/** float32 → BLOB (4 bytes per dimension). */
export function packF32(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function unpackF32(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

/**
 * int8 quantization for normalized vectors (1 byte per dimension, 4× smaller). Components of a unit
 * vector sit in [-1, 1]; each is scaled by 127. Cosine on dequantized vectors stays within ~1% of float.
 */
export function packI8(v: Float32Array): Buffer {
  const out = Buffer.alloc(v.length);
  for (let i = 0; i < v.length; i++) out.writeInt8(Math.max(-127, Math.min(127, Math.round(v[i]! * 127))), i);
  return out;
}

export function unpackI8(b: Uint8Array): Float32Array {
  const out = new Float32Array(b.length);
  const view = new Int8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < view.length; i++) out[i] = view[i]! / 127;
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

/** Cosine similarity of two vectors (normalizes, so it works on raw or quantized vectors). */
export function cosine(a: Float32Array, b: Float32Array): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i]! * b[i]!;
    aa += a[i]! * a[i]!;
    bb += b[i]! * b[i]!;
  }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

export interface Scored<T> {
  item: T;
  score: number;
}

/** Brute-force top-k by cosine similarity. */
export function topK<T>(query: Float32Array, items: Iterable<{ item: T; vector: Float32Array }>, k: number): Scored<T>[] {
  const all: Scored<T>[] = [];
  for (const { item, vector } of items) all.push({ item, score: cosine(query, vector) });
  return all.sort((x, y) => y.score - x.score).slice(0, k);
}

/**
 * Reciprocal Rank Fusion (Cormack et al.; k = 60): merge ranked lists (e.g. keyword + meaning) by
 * Σ 1/(k + rank). Robust to the lists' different score scales; no tuning needed.
 */
export function rrf<T>(lists: T[][], k = 60): Scored<T>[] {
  const scores = new Map<T, number>();
  for (const list of lists) list.forEach((item, i) => scores.set(item, (scores.get(item) ?? 0) + 1 / (k + i + 1)));
  return [...scores].map(([item, score]) => ({ item, score })).sort((a, b) => b.score - a.score);
}
