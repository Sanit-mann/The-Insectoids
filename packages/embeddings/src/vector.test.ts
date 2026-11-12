import { describe, expect, it } from 'vitest';
import { cosine, dot, normalize, packF32, packI8, rrf, topK, unpackF32, unpackI8 } from './vector';

const v = (...xs: number[]) => normalize(new Float32Array(xs));

describe('vectors for the Brain', () => {
  it('float32 BLOBs round-trip exactly', () => {
    const a = v(0.1, -0.5, 0.3, 0.9);
    expect([...unpackF32(packF32(a))]).toEqual([...a]);
  });

  it('int8 BLOBs are 4× smaller and keep cosine within ~1%', () => {
    const a = v(0.12, -0.53, 0.31, 0.9, -0.2, 0.05);
    const b = v(0.1, -0.4, 0.35, 0.8, -0.1, 0.0);
    const q = packI8(a);
    expect(q.length).toBe(a.length);
    expect(Math.abs(cosine(unpackI8(q), unpackI8(packI8(b))) - cosine(a, b))).toBeLessThan(0.01);
  });

  it('normalize gives unit vectors; dot equals cosine for unit vectors', () => {
    const a = v(3, 4);
    expect(dot(a, a)).toBeCloseTo(1, 6);
    expect(dot(a, v(4, 3))).toBeCloseTo(cosine(new Float32Array([3, 4]), new Float32Array([4, 3])), 6);
  });

  it('top-k returns the closest first', () => {
    const items = [
      { item: 'east', vector: v(1, 0) },
      { item: 'north', vector: v(0, 1) },
      { item: 'north-east', vector: v(1, 1) },
    ];
    expect(topK(v(0.9, 0.1), items, 2).map((s) => s.item)).toEqual(['east', 'north-east']);
  });

  it('reciprocal rank fusion rewards agreement between lists', () => {
    const fused = rrf([
      ['a', 'b', 'c'],
      ['b', 'c', 'a'],
    ]).map((s) => s.item);
    expect(fused[0]).toBe('b');
    expect(rrf([['x'], []]).map((s) => s.item)).toEqual(['x']);
  });
});
