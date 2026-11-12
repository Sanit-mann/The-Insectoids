import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Brain, openBrain } from './index';
import { packI8, rrf, unpackI8 } from './vectors';

const user = { type: 'user' } as const;
const MODEL = 'test-model';

/** A unit vector pointing along one axis (plus a little of another): easy-to-reason fake embeddings. */
const vec = (axis: number, tilt = 0, dim = 8): Float32Array => {
  const v = new Float32Array(dim);
  v[axis] = 1;
  if (tilt) v[(axis + 1) % dim] = tilt;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

let brain: Brain;
beforeEach(() => {
  let n = 0;
  brain = openBrain(':memory:', { newId: () => `r${++n}` });
});
afterEach(() => brain.close());

const write = (shelf: string, title: string, body: string) => brain.write({ kind: 'fact', shelf, title, body }, user).id;
const index = (id: string, v: Float32Array) => {
  const p = brain.pendingVectors(MODEL, 100).find((x) => x.id === id)!;
  expect(brain.setVector(id, MODEL, v, p.contentHash)).toBe(true);
};

describe('keyword search matches any meaningful word (Phase 2 B1)', () => {
  it('a natural sentence finds records sharing only some of its words; stop words are ignored', () => {
    const vault = write('site', 'Vault', 'API keys are encrypted with the OS and never leave this computer.');
    write('site', 'Theme', 'Dark and light colours.');
    // Requiring every word (Phase 1) found nothing here: "how", "does", "hive" aren't in the record.
    expect(brain.search('how does the hive keep keys encrypted', { shelf: 'site' }).map((h) => h.id)).toEqual([vault]);
  });

  it('records matching more of the words rank first', () => {
    const one = write('site', 'Keys', 'keys only');
    const both = write('site', 'Keys and vault', 'keys in the vault');
    expect(brain.search('keys vault', { shelf: 'site' }).map((h) => h.id)).toEqual([both, one]);
  });

  it('typed operators are kept as written', () => {
    write('site', 'Keys', 'keys only');
    const both = write('site', 'Keys and vault', 'keys in the vault');
    expect(brain.search('keys AND vault', { shelf: 'site' }).map((h) => h.id)).toEqual([both]);
  });

  it('a query of only stop words still searches those words', () => {
    const id = write('site', 'The', 'the');
    expect(brain.search('the', { shelf: 'site' }).map((h) => h.id)).toEqual([id]);
  });

  it('hits without a query vector say they were found by words', () => {
    write('site', 'Vault', 'keys');
    expect(brain.search('keys', { shelf: 'site' })[0]!.match).toBe('words');
  });
});

describe('vectors: pending, stale and progress', () => {
  it('lists records without a current vector; a changed record needs a new one', () => {
    const a = write('site', 'A', 'alpha');
    const b = write('site', 'B', 'beta');
    expect(brain.vectorProgress(MODEL)).toEqual({ indexed: 0, total: 2 });
    index(a, vec(0));
    expect(brain.pendingVectors(MODEL, 10).map((p) => p.id)).toEqual([b]);
    expect(brain.vectorProgress(MODEL)).toEqual({ indexed: 1, total: 2 });
    brain.update(a, { body: 'alpha, changed' }, user);
    expect(brain.pendingVectors(MODEL, 10).map((p) => p.id).sort()).toEqual([a, b]);
    expect(brain.vectorProgress(MODEL).indexed).toBe(0);
  });

  it('a vector made from content that changed meanwhile is ignored', () => {
    const a = write('site', 'A', 'alpha');
    const old = brain.pendingVectors(MODEL)[0]!;
    brain.update(a, { body: 'alpha, newer' }, user);
    expect(brain.setVector(a, MODEL, vec(0), old.contentHash)).toBe(false);
    expect(brain.vectorProgress(MODEL).indexed).toBe(0);
  });

  it('archived records need no vector and are never found by meaning', () => {
    const a = write('site', 'A', 'alpha');
    index(a, vec(0));
    brain.archive(a, user);
    expect(brain.pendingVectors(MODEL, 10)).toEqual([]);
    expect(brain.vectorProgress(MODEL)).toEqual({ indexed: 0, total: 0 });
    expect(brain.search('zzz', { shelf: 'site', queryVector: vec(0), vectorModel: MODEL })).toEqual([]);
  });

  it('vectors from another model are not compared', () => {
    const a = write('site', 'A', 'alpha');
    index(a, vec(0));
    expect(brain.search('zzz', { shelf: 'site', queryVector: vec(0), vectorModel: 'other-model' })).toEqual([]);
  });

  it('the text to embed carries title, summary and body, clipped', () => {
    brain.write({ kind: 'fact', shelf: 'site', title: 'T', summary: 'S', body: 'x'.repeat(5000) }, user);
    const p = brain.pendingVectors(MODEL)[0]!;
    expect(p.text.startsWith('T\nS\nxxx')).toBe(true);
    expect(p.text.length).toBeLessThanOrEqual(2000);
  });
});

describe('hybrid search (words + meaning, fused with RRF)', () => {
  it('finds a record by meaning when no word matches, and says how each hit was found', () => {
    const vault = write('site', 'Vault', 'API keys are encrypted.');
    const theme = write('site', 'Theme', 'Dark and light colours.');
    const both = write('site', 'Secrets broker', 'Insects never see the secret.');
    index(vault, vec(0));
    index(theme, vec(4));
    index(both, vec(0, 0.3));
    // "secret" matches only `both` by words; the query vector sits next to vault and both.
    const hits = brain.search('secret', { shelf: 'site', queryVector: vec(0), vectorModel: MODEL });
    expect(hits.map((h) => [h.id, h.match])).toEqual([
      [both, 'both'],
      [vault, 'meaning'],
    ]);
    // Far-away meaning (theme) stays out: below the similarity floor.
    expect(hits.some((h) => h.id === theme)).toBe(false);
  });

  it('meaning search keeps shelf scoping: the project and global, never another project', () => {
    const mine = write('site', 'Mine', 'one');
    const global = write('global', 'Global', 'two');
    const other = write('shop', 'Other project', 'three');
    for (const id of [mine, global, other]) index(id, vec(2));
    const ids = brain.search('zzz', { shelf: 'site', queryVector: vec(2), vectorModel: MODEL }).map((h) => h.id);
    expect(ids.sort()).toEqual([global, mine].sort());
  });

  it('kinds filter applies to meaning hits too', () => {
    const fact = write('site', 'Fact', 'one');
    const task = brain.write({ kind: 'task', shelf: 'site', title: 'Task', body: 'two' }, user).id;
    index(fact, vec(1));
    index(task, vec(1));
    const ids = brain.search('zzz', { shelf: 'site', kinds: ['task'], queryVector: vec(1), vectorModel: MODEL }).map((h) => h.id);
    expect(ids).toEqual([task]);
  });

  it('the token-budgeted read uses meaning too', () => {
    const vault = write('site', 'Vault', 'API keys are encrypted.');
    index(vault, vec(0));
    expect(brain.read('how are passwords protected', { shelf: 'site', queryVector: vec(0), vectorModel: MODEL }).ids).toEqual([vault]);
    expect(brain.read('how are passwords protected', { shelf: 'site' }).ids).toEqual([]);
  });
});

describe('vector helpers', () => {
  it('int8 packing keeps a unit vector within 1%', () => {
    const v = vec(3, 0.5);
    const back = unpackI8(packI8(v));
    for (let i = 0; i < v.length; i++) expect(Math.abs(back[i]! - v[i]!)).toBeLessThan(0.01);
  });

  it('RRF rewards appearing in both lists', () => {
    expect(rrf([['a', 'b'], ['b', 'c']]).map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });
});
