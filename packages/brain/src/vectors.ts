/**
 * Vector helpers for the Brain's meaning search (Phase 2 B1). Kept here, dependency-free, so the Brain
 * never loads the embedding model's runtime: vectors are made elsewhere (the Brain host) and only stored
 * and compared here.
 */

/** int8 quantization of a unit vector: each component in [-1, 1] scaled by 127 (cosine stays within ~1%). */
export function packI8(v: Float32Array): Buffer {
  const out = Buffer.alloc(v.length);
  for (let i = 0; i < v.length; i++) out.writeInt8(Math.max(-127, Math.min(127, Math.round(v[i]! * 127))), i);
  return out;
}

export function unpackI8(b: Uint8Array): Float32Array {
  const view = new Int8Array(b.buffer, b.byteOffset, b.byteLength);
  const out = new Float32Array(view.length);
  for (let i = 0; i < view.length; i++) out[i] = view[i]! / 127;
  return out;
}

/** Cosine similarity (normalizes, so quantized vectors compare correctly). */
export function cosine(a: Float32Array, b: Float32Array): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    ab += a[i]! * b[i]!;
    aa += a[i]! * a[i]!;
    bb += b[i]! * b[i]!;
  }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

/** Reciprocal Rank Fusion (k = 60): Σ 1/(k + rank) over the lists an item appears in. */
export function rrf(lists: string[][], k = 60): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...scores].map(([id, score]) => ({ id, score })).sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
}

/**
 * Words that carry no meaning for search. Dropped from "any word" keyword search, so a natural sentence
 * ("how does the hive keep keys away from insects") matches on its meaningful words only.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    'a an and are as at be been being but by can could did do does doing for from had has have having how i if in into is it its ' +
    'me my no not of on or our out so than that the their them then there these they this those to too up us was we were what ' +
    'when where which while who whom why will with would you your yours about after again all also am any because before both ' +
    'each few more most other own same should some such only just very s t ll d m re ve'
  ).split(' '),
);
