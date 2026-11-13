import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Brain, ConflictError, openBrain } from './index';

/** Brain screens (Phase 2 B5; Memory 01-D10–D13): safe user edits, the graph and the dashboard. */
const user = { type: 'user' } as const;
const ant = { type: 'agent', id: 'Ant-07' } as const;
const DAY = 86_400_000;

let brain: Brain;
let clock: number;

beforeEach(() => {
  clock = 100 * DAY;
  let n = 0;
  brain = openBrain(':memory:', { now: () => clock, newId: () => `r${++n}` });
});

afterEach(() => brain.close());

describe('edit with an expected version (01-D12)', () => {
  it('saves when nobody changed the record since', () => {
    const { id } = brain.write({ kind: 'fact', shelf: 's', title: 'Port', body: '3000' }, ant);
    const v = brain.update(id, { body: '3001', trust: 'confirmed', expectedVersion: 1 }, user);
    expect(v).toBe(2);
    expect(brain.get(id)).toMatchObject({ body: '3001', trust: 'confirmed', version: 2 });
  });

  it('refuses, and writes nothing, when an agent changed it after the version the user started from', () => {
    const { id } = brain.write({ kind: 'fact', shelf: 's', title: 'Port', body: '3000' }, ant);
    brain.update(id, { body: '4000' }, ant);
    expect(() => brain.update(id, { body: '3001', expectedVersion: 1 }, user)).toThrow(ConflictError);
    expect(brain.get(id)).toMatchObject({ body: '4000', version: 2 });
    expect(brain.history(id)).toHaveLength(2);
  });
});

describe('graph (01-D13): nodes by importance, edges only from real links', () => {
  const seed = () => {
    const a = brain.write({ kind: 'decision', shelf: 'site', title: 'Use Astro', body: 'Static blog.' }, user).id;
    const b = brain.write({ kind: 'task', shelf: 'site', title: 'Set up Astro', body: 'npm create astro' }, ant).id;
    const c = brain.write({ kind: 'fact', shelf: 'global', title: 'Node 22', body: 'The PC runs Node 22.' }, ant).id;
    const d = brain.write({ kind: 'update', shelf: 'other', title: 'Other project note', body: 'Elsewhere.' }, ant).id;
    brain.link(b, a, 'implements');
    brain.link(b, c, 'uses');
    brain.link(d, a, 'mentions');
    return { a, b, c, d };
  };

  it('a project shelf includes global records, never other projects; edges need both ends', () => {
    const { a, b, c, d } = seed();
    const g = brain.graph({ shelf: 'site', limit: 50 });
    expect(g.nodes.map((n) => n.id).sort()).toEqual([a, b, c].sort());
    expect(g.nodes.map((n) => n.id)).not.toContain(d);
    expect(g.edges).toEqual(expect.arrayContaining([{ from: b, to: a, rel: 'implements' }, { from: b, to: c, rel: 'uses' }]));
    expect(g.edges).toHaveLength(2);
    expect(g.hidden).toBe(0);
  });

  it('all shelves: every record and every link', () => {
    seed();
    const g = brain.graph({ limit: 50 });
    expect(g.nodes).toHaveLength(4);
    expect(g.edges).toHaveLength(3);
  });

  it('limit keeps the most important and counts the rest as hidden', () => {
    const { a } = seed();
    brain.noteRead([a]);
    brain.noteRead([a]);
    brain.noteRead([a]);
    const g = brain.graph({ limit: 1 });
    expect(g.nodes.map((n) => n.id)).toEqual([a]);
    expect(g.hidden).toBe(3);
    expect(g.edges).toEqual([]);
    const all = brain.graph({ limit: 10 });
    for (let i = 1; i < all.nodes.length; i++) expect(all.nodes[i - 1]!.importance).toBeGreaterThanOrEqual(all.nodes[i]!.importance);
  });

  it('filters by kind and by date', () => {
    const { a } = seed();
    expect(brain.graph({ kinds: ['decision'], limit: 50 }).nodes.map((n) => n.id)).toEqual([a]);
    clock += 10 * DAY;
    const e = brain.write({ kind: 'update', shelf: 'site', title: 'Later note', body: 'Ten days on.' }, ant).id;
    expect(brain.graph({ since: clock - DAY, limit: 50 }).nodes.map((n) => n.id)).toEqual([e]);
  });

  it('archived records are left out unless asked for, and then marked', () => {
    const { b } = seed();
    brain.archive(b, user);
    expect(brain.graph({ limit: 50 }).nodes.map((n) => n.id)).not.toContain(b);
    const g = brain.graph({ includeArchived: true, limit: 50 });
    expect(g.nodes.find((n) => n.id === b)).toMatchObject({ archived: true });
    expect(g.edges.filter((e) => e.from === b)).toHaveLength(2);
  });
});

describe('dashboard (01-D13 phase 2)', () => {
  it('counts, kinds, eight weeks, most used and a timeline', () => {
    clock = 100 * DAY;
    const a = brain.write({ kind: 'decision', shelf: 'site', title: 'Use Astro', body: 'Static blog.' }, user).id;
    clock += 20 * DAY; // 2-3 weeks later
    const b = brain.write({ kind: 'fact', shelf: 'site', title: 'Port', body: '3000' }, ant).id;
    const c = brain.write({ kind: 'fact', shelf: 'global', title: 'Node 22', body: 'Node 22.' }, ant).id;
    brain.write({ kind: 'update', shelf: 'other', title: 'Other', body: 'Elsewhere.' }, ant);
    brain.link(b, a, 'about');
    brain.noteRead([a, b], 'card:x:a1');
    brain.update(b, { body: '3001' }, ant);
    brain.archive(c, user);

    const d = brain.dashboard('site');
    expect(d.shelf).toBe('site');
    expect(d.totals).toEqual({ records: 3, archived: 1, confirmed: 1, links: 1 });
    expect(d.byKind).toEqual(expect.arrayContaining([{ kind: 'decision', count: 1 }, { kind: 'fact', count: 1 }]));
    expect(d.byKind.find((k) => k.kind === 'update')).toBeUndefined();

    expect(d.weeks).toHaveLength(8);
    expect(d.weeks.at(-1)!.weekStart).toBe(clock - 7 * DAY);
    expect(d.weeks.at(-1)).toMatchObject({ added: 2, reads: 2 });
    expect(d.weeks.reduce((n, w) => n + w.added, 0)).toBe(3);

    expect(d.mostUsed.map((m) => m.id)).toEqual(expect.arrayContaining([a, b]));
    expect(d.mostUsed.map((m) => m.id)).not.toContain(c);
    expect(d.mostUsed.length).toBeLessThanOrEqual(5);

    expect(d.timeline[0]).toMatchObject({ id: c, change: 'archive', changedBy: 'user' });
    expect(d.timeline[1]).toMatchObject({ id: b, change: 'update', version: 2, changedBy: 'Ant-07', title: 'Port' });
    expect(d.timeline.every((t) => t.title !== 'Other')).toBe(true);
    for (let i = 1; i < d.timeline.length; i++) expect(d.timeline[i - 1]!.changedAt).toBeGreaterThanOrEqual(d.timeline[i]!.changedAt);
  });

  it('the global shelf on its own', () => {
    brain.write({ kind: 'fact', shelf: 'global', title: 'Node 22', body: 'Node 22.' }, ant);
    brain.write({ kind: 'fact', shelf: 'site', title: 'Port', body: '3000' }, ant);
    expect(brain.dashboard('global').totals.records).toBe(1);
  });
});
