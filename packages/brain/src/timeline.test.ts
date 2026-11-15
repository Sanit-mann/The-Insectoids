import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Brain, type TimelineEntry, type TimelineOptions, openBrain } from './index';
import type { NewCard } from './taskboard';

const user = { type: 'user' } as const;
const ant = { type: 'agent', id: 'Ant-02' } as const;
const scout = { type: 'agent', id: 'Scout' } as const;

let brain: Brain;
let clock: number;

beforeEach(() => {
  clock = 1_000;
  let n = 0;
  brain = openBrain(':memory:', { now: () => clock, newId: () => `r${String(++n).padStart(3, '0')}` });
});
afterEach(() => brain.close());

const all = (opts: Partial<TimelineOptions> = {}): TimelineEntry[] => brain.timeline({ limit: 200, ...opts }).entries;
const keys = (es: TimelineEntry[]): string[] => es.map((e) => `${e.recordId}@${e.version}`);

describe('order and keyset paging (Phase 4 A3)', () => {
  it('newest first by time, then record, then version, and pages never skip or repeat across equal times', () => {
    // 12 records at three shared timestamps, some edited in the same millisecond as they were made.
    for (let t = 0; t < 3; t++) {
      clock = 5_000 + t;
      for (let i = 0; i < 4; i++) {
        const { id } = brain.write({ kind: 'update', shelf: 'site', title: `Note ${t}-${i}`, body: `Body ${t} ${i}` }, user);
        if (i % 2 === 0) brain.update(id, { body: `Body ${t} ${i} edited` }, user);
      }
    }
    const full = all();
    expect(full).toHaveLength(18);
    for (let i = 1; i < full.length; i++) {
      const a = full[i - 1]!;
      const b = full[i]!;
      const cmp = a.changedAt - b.changedAt || (a.recordId > b.recordId ? 1 : a.recordId < b.recordId ? -1 : 0) || a.version - b.version;
      expect(cmp).toBeGreaterThan(0);
    }

    for (const size of [1, 4, 5, 17]) {
      const seen: string[] = [];
      let before: TimelineOptions['before'];
      for (let guard = 0; guard < 50; guard++) {
        const page = brain.timeline({ limit: size, ...(before ? { before } : {}) });
        seen.push(...keys(page.entries));
        if (!page.nextCursor) break;
        before = page.nextCursor;
      }
      expect(seen).toEqual(keys(full));
    }
  });

  it('says there is no next page when the last page is exactly full', () => {
    for (let i = 0; i < 4; i++) brain.write({ kind: 'update', shelf: 'site', title: `N${i}`, body: `B${i}` }, user);
    const first = brain.timeline({ limit: 2 });
    expect(first.nextCursor).not.toBeNull();
    const second = brain.timeline({ limit: 2, before: first.nextCursor! });
    expect(second.entries).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
  });
});

describe('filters', () => {
  beforeEach(() => {
    clock = 10_000;
    brain.write({ kind: 'fact', shelf: 'site', title: 'Port is 3000', body: 'Dev server port.' }, ant); // r001 v1 @10000
    clock = 20_000;
    brain.write({ kind: 'decision', shelf: 'global', title: 'Use 100%_pure CSS', body: 'No CSS-in-JS.' }, user); // r002 @20000
    clock = 30_000;
    brain.write({ kind: 'update', shelf: 'other', title: 'Other project note', body: 'Elsewhere.' }, scout); // r003 @30000
    clock = 40_000;
    brain.update('r001', { trust: 'confirmed' }, user); // r001 v2 @40000
    clock = 50_000;
    brain.archive('r003', user); // r003 v2 @50000
  });

  it('by shelves (undefined = all; [] = none)', () => {
    expect(keys(all())).toEqual(['r003@2', 'r001@2', 'r003@1', 'r002@1', 'r001@1']);
    expect(keys(all({ shelves: ['site', 'global'] }))).toEqual(['r001@2', 'r002@1', 'r001@1']);
    expect(keys(all({ shelves: ['global'] }))).toEqual(['r002@1']);
    expect(all({ shelves: [] })).toEqual([]);
  });

  it('by kinds and by changes', () => {
    expect(keys(all({ kinds: ['fact'] }))).toEqual(['r001@2', 'r001@1']);
    expect(keys(all({ changes: ['create'] }))).toEqual(['r003@1', 'r002@1', 'r001@1']);
    expect(keys(all({ changes: ['update', 'archive'] }))).toEqual(['r003@2', 'r001@2']);
  });

  it("by actor: the user's own, agents', or one agent", () => {
    expect(keys(all({ actor: 'user' }))).toEqual(['r003@2', 'r001@2', 'r002@1']);
    expect(keys(all({ actor: 'agents' }))).toEqual(['r003@1', 'r001@1']);
    expect(keys(all({ actor: 'Scout' }))).toEqual(['r003@1']);
    expect(all({ actor: 'Nobody' })).toEqual([]);
    expect(all({ actor: 'agents' }).every((e) => e.actorType === 'agent')).toBe(true);
    expect(all({ actor: 'user' }).every((e) => e.actorType === 'user')).toBe(true);
  });

  it('by words in the title at that version (every word, any case; % and _ are literal)', () => {
    expect(keys(all({ query: 'port' }))).toEqual(['r001@2', 'r001@1']);
    expect(keys(all({ query: 'PORT 3000' }))).toEqual(['r001@2', 'r001@1']);
    expect(keys(all({ query: 'port 4000' }))).toEqual([]);
    expect(keys(all({ query: '100%_pure' }))).toEqual(['r002@1']);
    expect(keys(all({ query: '%' }))).toEqual(['r002@1']);
    expect(keys(all({ query: '_' }))).toEqual(['r002@1']);
    expect(keys(all({ query: '   ' }))).toHaveLength(5);
  });

  it('by time: since is inclusive, until is exclusive', () => {
    expect(keys(all({ since: 20_000, until: 50_000 }))).toEqual(['r001@2', 'r003@1', 'r002@1']);
    expect(keys(all({ since: 50_000 }))).toEqual(['r003@2']);
    expect(keys(all({ until: 10_000 }))).toEqual([]);
  });

  it('the actor list: user first, then agents A–Z, within the shelves and time', () => {
    brain.write({ kind: 'update', shelf: 'site', title: 'A note', body: 'by the Librarian' }, { type: 'agent', id: 'Librarian' });
    expect(brain.timelineActors()).toEqual(['user', 'Ant-02', 'Librarian', 'Scout']);
    expect(brain.timelineActors(['site', 'global'])).toEqual(['user', 'Ant-02', 'Librarian']);
    expect(brain.timelineActors(['other'], 30_000, 40_000)).toEqual(['Scout']);
    expect(brain.timelineActors(['site'], 0, 20_000)).toEqual(['Ant-02']);
    expect(brain.timelineActors([])).toEqual([]);
  });
});

describe('what happened, in plain words', () => {
  const what = (id: string, version: number): string | undefined => all().find((e) => e.recordId === id && e.version === version)?.what;

  it('created, edited, confirmed, edited and confirmed', () => {
    const a = brain.write({ kind: 'fact', shelf: 'site', title: 'Brand font', body: 'Satoshi' }, ant).id;
    const b = brain.write({ kind: 'fact', shelf: 'site', title: 'Brand colour', body: 'Teal' }, ant).id;
    brain.update(a, { body: 'Satoshi Variable' }, ant);
    brain.update(a, { trust: 'confirmed' }, user);
    brain.update(a, { body: 'Satoshi, 16px' }, user);
    brain.update(b, { body: 'Teal #0aa', trust: 'confirmed' }, user);
    expect(what(a, 1)).toBe('Created');
    expect(what(a, 2)).toBe('Edited');
    expect(what(a, 3)).toBe('Confirmed');
    expect(what(a, 4)).toBe('Edited');
    expect(what(b, 2)).toBe('Edited and confirmed');
  });

  it('archived: faded with its reason, by you, only the latest archive keeps its reason, brought back', () => {
    const a = brain.write({ kind: 'update', shelf: 'site', title: 'Old note', body: 'x' }, ant).id;
    const b = brain.write({ kind: 'update', shelf: 'site', title: 'Another note', body: 'y' }, user).id;
    const c = brain.write({ kind: 'update', shelf: 'site', title: 'Third note', body: 'z' }, user).id;
    brain.archive(a, { type: 'agent', id: 'brain-tidy' }, 'faded: unused for 60 days');
    brain.archive(b, user);
    brain.archive(c, user, "archived on the Librarian's advice");
    brain.unarchive(b, user);
    expect(what(a, 2)).toBe('Faded into the archive: unused for 60 days');
    expect(what(b, 2)).toBe('Archived');
    expect(what(b, 3)).toBe('Brought back');
    expect(what(c, 2)).toBe("Archived: archived on the Librarian's advice");
    brain.archive(b, user);
    expect(what(b, 4)).toBe('Archived by you');
  });

  it('replaced by the newer record, merged into the kept one, merged in a near-duplicate', () => {
    const old = brain.write({ kind: 'fact', shelf: 'site', title: 'Port is 3000', body: 'Dev port.' }, user).id;
    const neu = brain.write({ kind: 'fact', shelf: 'site', title: 'Port is 4000', body: 'Dev port moved.', supersedes: old }, user).id;
    expect(what(old, 2)).toBe('Replaced by "Port is 4000"');
    expect(neu).not.toBe(old);

    const keep = brain.write({ kind: 'update', shelf: 'site', title: 'Keep me', body: 'one' }, user).id;
    const fold = brain.write({ kind: 'update', shelf: 'site', title: 'Fold me', body: 'two' }, user).id;
    brain.mergeRecords(keep, fold, user);
    expect(what(fold, 2)).toBe('Merged into "Keep me"');

    // An agent's near-duplicate of an agent note is folded in as it is written (01-E5).
    const note = brain.write({ kind: 'update', shelf: 'site', title: 'Build runs with pnpm', body: 'Run pnpm build in the root folder.' }, ant).id;
    clock += 1;
    const r = brain.write({ kind: 'update', shelf: 'site', title: 'Build runs with pnpm', body: 'Run pnpm build in the root folder!' }, ant);
    expect(r.merged).toBe(true);
    const folded = all().find((e) => e.change === 'create' && e.changedAt === clock && e.recordId !== note)!;
    expect(folded.what).toBe('Merged into "Build runs with pnpm"');
    expect(what(note, 2)).toBe('Merged in "Build runs with pnpm"');
  });

  it('the title then, and the title now when it changed', () => {
    const id = brain.write({ kind: 'update', shelf: 'site', title: 'Draft name', body: 'x' }, user).id;
    brain.update(id, { title: 'Final name' }, user);
    const [now, then] = all();
    expect(now).toMatchObject({ version: 2, title: 'Final name', currentTitle: null });
    expect(then).toMatchObject({ version: 1, title: 'Draft name', currentTitle: 'Final name' });
  });
});

describe('the goal a change came from', () => {
  const card = (over: Partial<NewCard> = {}): NewCard => ({
    id: 'C-01',
    goalId: 'G-1',
    wave: 1,
    title: 'Build the pricing page',
    brief: 'Three plans.',
    caste: 'coder',
    priority: 'normal',
    acceptance: ['Tests pass'],
    dependsOn: [],
    ...over,
  });
  const run = (over: { runId: string; goalId: string | null; role: string; at: number; durationMs: number }) => ({
    cardId: null,
    priority: 'normal',
    engine: 'fake',
    tier: 'standard',
    model: 'm',
    effort: 'medium',
    attempt: 0,
    result: 'pass' as const,
    tokensIn: 0,
    tokensOut: 0,
    tokensCache: 0,
    costUsd: 0,
    costEstimated: false,
    ...over,
  });
  const entry = (id: string, version = 1): TimelineEntry => all().find((e) => e.recordId === id && e.version === version)!;

  beforeEach(() => {
    brain.goals.create({ id: 'G-1', title: 'Pricing page', text: 'Build it.', shelf: 'site' });
    brain.goals.create({ id: 'G-2', title: 'Blog', text: 'Write it.', shelf: 'site' });
    brain.goals.create({ id: 'G-9', title: 'Elsewhere', text: 'Other project.', shelf: 'other' });
  });

  it('an insect holding a card: from its claim until the card leaves it', () => {
    clock = 100;
    brain.taskboard.post(card());
    clock = 200;
    brain.taskboard.claim('C-01', { agentId: 'Ant-02', caste: 'coder', leaseMs: 60_000 });
    brain.taskboard.start('C-01', 'Ant-02');
    clock = 300;
    const during = brain.write({ kind: 'update', shelf: 'site', title: 'Pricing uses Stripe', body: 'Checkout via Stripe.' }, ant).id;
    clock = 310;
    const global = brain.write({ kind: 'update', shelf: 'global', title: 'Global tip', body: 'Prefer pnpm.' }, ant).id;
    clock = 400;
    brain.taskboard.submit('C-01', 'Ant-02', 'done');
    clock = 500;
    const after = brain.write({ kind: 'update', shelf: 'site', title: 'Late note', body: 'After the card.' }, ant).id;
    const mine = brain.write({ kind: 'update', shelf: 'site', title: 'My note', body: 'By me.' }, user).id;

    expect(entry(during)).toMatchObject({ goalId: 'G-1', goalTitle: 'Pricing page' });
    expect(entry(global)).toMatchObject({ goalId: 'G-1' });
    expect(entry(after)).toMatchObject({ goalId: null, goalTitle: null });
    expect(entry(mine)).toMatchObject({ goalId: null });
  });

  it('a blocked card stays with its insect; a card for another shelf never links', () => {
    brain.taskboard.post(card({ id: 'C-09', goalId: 'G-9' }));
    clock = 200;
    brain.taskboard.claim('C-09', { agentId: 'Ant-02', caste: 'coder', leaseMs: 60_000 });
    brain.taskboard.start('C-09', 'Ant-02');
    brain.taskboard.block('C-09', 'Ant-02', 'Needs approval');
    clock = 300;
    const onOther = brain.write({ kind: 'update', shelf: 'other', title: 'Other shelf note', body: 'x' }, ant).id;
    const onSite = brain.write({ kind: 'update', shelf: 'site', title: 'Site note', body: 'y' }, ant).id;
    expect(entry(onOther).goalId).toBe('G-9');
    expect(entry(onSite).goalId).toBeNull();
  });

  it('the latest claim wins when an agent id was used again later (a new session)', () => {
    brain.taskboard.post(card({ id: 'C-01', goalId: 'G-1' }));
    brain.taskboard.post(card({ id: 'C-02', goalId: 'G-2' }));
    clock = 200;
    brain.taskboard.claim('C-01', { agentId: 'Ant-02', caste: 'coder', leaseMs: 60_000 }); // never released (the app closed)
    clock = 1_000;
    brain.taskboard.claim('C-02', { agentId: 'Ant-02', caste: 'coder', leaseMs: 60_000 });
    clock = 1_100;
    const id = brain.write({ kind: 'update', shelf: 'site', title: 'Blog layout', body: 'Two columns.' }, ant).id;
    expect(entry(id).goalId).toBe('G-2');
  });

  it('per-goal runs without a card (Queen, Scout, Inspector): only when one goal ran then', () => {
    // Scout ran for G-1 from 1000 to 2000; Queen ran for G-1 (1000–3000) and for G-2 (2500–4000) at once.
    brain.outcomes.record(run({ runId: 'G-1:Scout#1', goalId: 'G-1', role: 'scout', at: 2_000, durationMs: 1_000 }));
    brain.outcomes.record(run({ runId: 'G-1:Queen#2', goalId: 'G-1', role: 'queen', at: 3_000, durationMs: 2_000 }));
    brain.outcomes.record(run({ runId: 'G-2:Queen#3', goalId: 'G-2', role: 'queen', at: 4_000, durationMs: 1_500 }));
    const queen = { type: 'agent', id: 'Queen' } as const;
    clock = 1_500;
    const s = brain.write({ kind: 'update', shelf: 'site', title: 'Survey', body: 'Repo layout.' }, scout).id;
    const q1 = brain.write({ kind: 'update', shelf: 'site', title: 'Plan one', body: 'Waves.' }, queen).id;
    clock = 2_700;
    const both = brain.write({ kind: 'update', shelf: 'site', title: 'Plan both', body: 'Overlap.' }, queen).id;
    clock = 3_500;
    const q2 = brain.write({ kind: 'update', shelf: 'site', title: 'Plan two', body: 'Blog waves.' }, queen).id;
    clock = 9_000;
    const none = brain.write({ kind: 'update', shelf: 'site', title: 'Plan later', body: 'No run.' }, queen).id;

    expect(entry(s).goalId).toBe('G-1');
    expect(entry(q1)).toMatchObject({ goalId: 'G-1', goalTitle: 'Pricing page' });
    expect(entry(both).goalId).toBeNull();
    expect(entry(q2)).toMatchObject({ goalId: 'G-2', goalTitle: 'Blog' });
    expect(entry(none).goalId).toBeNull();
  });
});

describe('the timeline index (schema v15)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'insectoids-timeline-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a v14 Brain gets the index when it opens, and the timeline query walks it without sorting', () => {
    const file = join(dir, 'brain.db');
    openBrain(file).close();
    const raw = new DatabaseSync(file);
    try {
      // v16's columns go too, so reopening runs v15 and then v16, as for a real v14 Brain.
      raw.exec('DROP INDEX record_versions_time; DROP INDEX task_events_actor; ALTER TABLE goals DROP COLUMN containers; ALTER TABLE tasks DROP COLUMN container_move; PRAGMA user_version = 14;');
    } finally {
      raw.close();
    }
    openBrain(file).close();
    const db = new DatabaseSync(file);
    try {
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(16);
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name);
      expect(names).toEqual(expect.arrayContaining(['record_versions_time', 'task_events_actor']));
      const plan = (
        db
          .prepare(
            // The shape of Brain.timeline's query.
            `EXPLAIN QUERY PLAN SELECT v.record_id FROM record_versions v CROSS JOIN records r ON r.id = v.record_id
             WHERE r.shelf IN ('a', 'global') AND (v.changed_at, v.record_id, v.version) < (5, 'x', 1)
             ORDER BY v.changed_at DESC, v.record_id DESC, v.version DESC LIMIT 51`,
          )
          .all() as Array<{ detail: string }>
      ).map((r) => r.detail);
      expect(plan.join('\n')).toContain('record_versions_time');
      expect(plan.join('\n')).not.toContain('TEMP B-TREE');
    } finally {
      db.close();
    }
  });

  it('stays fast with 50,000 versions', () => {
    const file = join(dir, 'big.db');
    openBrain(file).close();
    const raw = new DatabaseSync(file);
    const RECORDS = 12_500;
    const shelves = ['site', 'global', 'other', 'blog'];
    const actors = ['user', 'Ant-01', 'Ant-02', 'Queen', 'Librarian'];
    raw.exec('BEGIN');
    const rec = raw.prepare(
      `INSERT INTO records (id, kind, shelf, owner, title, body, trust, content_hash, version, created_at, updated_at, valid_from)
       VALUES (?, 'update', ?, 'user', ?, 'body', 'confirmed', ?, 4, ?, ?, ?)`,
    );
    const ver = raw.prepare(
      `INSERT INTO record_versions (record_id, version, change, title, body, trust, changed_by, changed_at) VALUES (?, ?, ?, ?, 'body', 'confirmed', ?, ?)`,
    );
    for (let i = 0; i < RECORDS; i++) {
      const id = `rec-${String(i).padStart(6, '0')}`;
      // Many share a millisecond: 4 versions per record over ~2,500 distinct times.
      const t = 1_000_000 + Math.floor(i / 5) * 1_000;
      rec.run(id, shelves[i % shelves.length]!, `Note number ${i}`, `h${i}`, t, t + 3_000, t);
      for (let v = 1; v <= 4; v++) ver.run(id, v, v === 1 ? 'create' : 'update', `Note number ${i}`, actors[(i + v) % actors.length]!, t + (v - 1) * 1_000);
    }
    raw.exec('COMMIT');
    raw.close();

    const big = openBrain(file);
    try {
      const time = (fn: () => unknown): number => {
        fn(); // warm the statement cache and pages
        const t0 = performance.now();
        for (let i = 0; i < 5; i++) fn();
        return (performance.now() - t0) / 5;
      };
      const project = ['site', 'global'];
      let cursor: TimelineOptions['before'];
      const first = time(() => (cursor = big.timeline({ shelves: project, limit: 50 }).nextCursor ?? undefined));
      const deep = time(() => big.timeline({ shelves: project, limit: 50, before: { changedAt: 1_500_000, recordId: 'rec-002500', version: 1 } }));
      const next = time(() => big.timeline({ shelves: project, limit: 50, ...(cursor ? { before: cursor } : {}) }));
      const filtered = time(() => big.timeline({ shelves: project, actor: 'Queen', changes: ['create'], limit: 50 }));
      const query = time(() => big.timeline({ shelves: project, query: 'number 1234', limit: 50 }));
      const rare = time(() => big.timeline({ shelves: project, query: 'no such words', limit: 50 }));
      const actorsAll = time(() => big.timelineActors());
      const actorsProject = time(() => big.timelineActors(project));
      const numbers = { first, next, deep, filtered, query, rare, actorsAll, actorsProject };
      console.log(`[timeline 50k versions] ms per call: ${Object.entries(numbers).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ')}`);
      expect(big.timeline({ shelves: project, limit: 50 }).entries).toHaveLength(50);
      expect(big.timelineActors()).toEqual(['user', 'Ant-01', 'Ant-02', 'Librarian', 'Queen']);
      // Generous bounds for slow CI machines; the numbers above are what matters.
      expect(first).toBeLessThan(50);
      expect(next).toBeLessThan(50);
      expect(filtered).toBeLessThan(250);
      expect(actorsProject).toBeLessThan(500);
    } finally {
      big.close();
    }
  });
});
