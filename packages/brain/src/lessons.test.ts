import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Brain, HEALTH_WEIGHTS, TrustError, brainHealth, openBrain } from './index';
import type { HealthCounts } from './brain';

/** Phase 2 B3 in the Brain: the lessons register (01-E10), merges as the user, audits and health (01-E12). */
const user = { type: 'user' } as const;
const lib = { type: 'agent', id: 'Librarian' } as const;
const ant = { type: 'agent', id: 'Ant-07' } as const;
const DAY = 86_400_000;

let brain: Brain;
let clock: number;

beforeEach(() => {
  clock = 1_000_000_000_000;
  let n = 0;
  brain = openBrain(':memory:', { now: () => clock, newId: () => `r${++n}` });
});

afterEach(() => brain.close());

const learn = (title: string, shelf = 'site') => brain.learn({ shelf, title, body: `What the Inspector found: ${title}`, source: 'g1.C-01' }, lib);

describe('lessons (01-E10)', () => {
  it('an agent lesson is unconfirmed; a near-duplicate folds in and counts as seen again', () => {
    const a = learn("Don't hand in \"Write hello.txt\" as done because hello.txt has no greeting");
    expect(a).toMatchObject({ created: true, seen: 1 });
    expect(brain.get(a.id)).toMatchObject({ kind: 'lesson', trust: 'unconfirmed', owner: 'Librarian' });
    const b = learn("Don't hand in \"Write hello.txt\" as done because hello.txt has no greeting.");
    expect(b).toMatchObject({ id: a.id, created: false, seen: 2 });
    expect(brain.lessons('site')).toEqual([expect.objectContaining({ id: a.id, seen: 2 })]);
  });

  it('agents cannot confirm a lesson; the user can', () => {
    const { id } = learn("Don't ship the form because the submit button does nothing");
    expect(() => brain.update(id, { trust: 'confirmed' }, ant)).toThrow(TrustError);
    brain.update(id, { trust: 'confirmed' }, user);
    expect(brain.get(id)!.trust).toBe('confirmed');
  });

  it('lessons(): project plus global, newest first, at most the limit, archived ones left out', () => {
    learn("Don't use tabs because the linter wants spaces", 'global');
    clock += 1000;
    const site = learn("Don't skip tests because the Inspector runs them");
    clock += 1000;
    const gone = learn("Don't commit build output because it bloats the repo");
    learn("Don't touch other shelves because they belong to other projects", 'other');
    brain.archive(gone.id, user, 'retired by you');
    expect(brain.lessons('site').map((l) => l.id)).toEqual([site.id, 'r1']);
    expect(brain.lessons('site', 1)).toHaveLength(1);
  });

  it('boot card: confirmed lessons first, then up to 3 recent unconfirmed', () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      clock += 1000;
      ids.push(learn(`Lesson number ${i}: don't do thing ${'abcde'[i]} because of reason ${'vwxyz'[i]}`).id);
    }
    brain.update(ids[0]!, { trust: 'confirmed' }, user);
    const card = brain.bootCard('site');
    const section = card.split('Lessons (avoid these):\n')[1]!.split('\n').filter((l) => l.startsWith('- '));
    expect(section).toEqual([
      expect.stringContaining('Lesson number 0'),
      expect.stringContaining('Lesson number 4'),
      expect.stringContaining('Lesson number 3'),
      expect.stringContaining('Lesson number 2'),
    ]);
  });

  it('confirmed lessons never fade; old unconfirmed, unused ones do', () => {
    const keep = learn("Don't hand in the docs as done because the links are broken").id;
    const fade = learn("Don't use the old API because it was removed in May").id;
    brain.update(keep, { trust: 'confirmed' }, user);
    clock += 200 * DAY;
    const faded = brain.fade().map((f) => f.id);
    expect(faded).toContain(fade);
    expect(faded).not.toContain(keep);
    expect(brain.get(keep)!.archived).toBe(false);
  });
});

describe('mergeRecords and duplicatePairs (B3)', () => {
  it('only the user merges; the folded record is archived and linked, never deleted', () => {
    const keep = brain.write({ kind: 'fact', shelf: 'site', title: 'Deploys', body: 'We deploy from the main branch every Friday.' }, user).id;
    const fold = brain.write({ kind: 'fact', shelf: 'site', title: 'Deploy day', body: 'Deploys happen from main on Fridays.' }, ant).id;
    expect(() => brain.mergeRecords(keep, fold, ant)).toThrow(TrustError);
    brain.mergeRecords(keep, fold, user);
    expect(brain.get(fold)).toMatchObject({ archived: true, archivedReason: `merged into ${keep}` });
    expect(brain.links(keep)).toContainEqual(expect.objectContaining({ rel: 'merged_into', direction: 'in' }));
  });

  it('finds near-duplicate pairs that involve the user (agents can not fold those away)', () => {
    // An agent's later near-duplicate of the user's note isn't saved at all (B2); the user writing one
    // after the agent's is what leaves a pair only the user can merge.
    brain.write({ kind: 'fact', shelf: 'site', title: 'Hosting', body: 'The site is hosted on Vercel in the EU region!' }, ant);
    brain.write({ kind: 'fact', shelf: 'site', title: 'Hosting', body: 'The site is hosted on Vercel in the EU region.' }, user);
    brain.write({ kind: 'fact', shelf: 'site', title: 'Analytics', body: 'We count visits with a self-hosted Plausible.' }, ant);
    const pairs = brain.duplicatePairs('site');
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ userInvolved: true });
    expect(pairs[0]!.similarity).toBeGreaterThanOrEqual(0.9);
  });
});

describe('health counts and score (01-E12)', () => {
  it('counts each part on the shelf and the global shelf', () => {
    brain.write({ kind: 'fact', shelf: 'site', title: 'Old fact', body: 'Written long ago and never used.' }, user);
    brain.write({ kind: 'fact', shelf: 'site', title: 'Proposed', body: 'An agent thinks this is true.' }, ant);
    learn("Don't hand in the docs as done because the links are broken");
    brain.write({ kind: 'update', shelf: 'other', title: 'Elsewhere', body: 'Another project.' }, ant);
    clock += 100 * DAY;
    expect(brain.healthCounts('site')).toEqual({ total: 3, stale: 3, waiting: 1, orphans: 3, unused: 3, lessons: 1 });
  });

  const zero: HealthCounts = { total: 100, stale: 0, waiting: 0, orphans: 0, unused: 0, lessons: 0 };
  it.each<[string, HealthCounts, number, number]>([
    ['a tidy Brain', zero, 0, 100],
    ['10% stale costs 4', { ...zero, stale: 10 }, 0, 96],
    ['stale caps at 25', { ...zero, stale: 100 }, 0, 75],
    ['3 waiting cost 6', { ...zero, waiting: 3 }, 0, 94],
    ['waiting caps at 20', { ...zero, waiting: 50 }, 0, 80],
    ['20% orphans cost 6', { ...zero, orphans: 20 }, 0, 94],
    ['40% unused cost 10', { ...zero, unused: 40 }, 0, 90],
    ['2 duplicate pairs cost 6', zero, 2, 94],
    ['duplicates cap at 15', zero, 9, 85],
    ['lessons cap at 10', { ...zero, lessons: 9 }, 0, 90],
    ['everything at its cap floors at 0', { total: 100, stale: 100, waiting: 99, orphans: 100, unused: 100, lessons: 99 }, 99, 0],
    ['an empty Brain is tidy', { total: 0, stale: 0, waiting: 0, orphans: 0, unused: 0, lessons: 0 }, 0, 100],
  ])('%s', (_label, counts, dups, score) => {
    expect(brainHealth(counts, dups, 1).score).toBe(score);
  });

  it('the caps add up to exactly 100: every part at its cap gives 0', () => {
    const caps = Object.values(HEALTH_WEIGHTS).reduce((s, w) => s + w.cap, 0);
    expect(caps).toBe(100);
  });

  it('is null before the first audit, and names the biggest item otherwise', () => {
    expect(brainHealth(zero, 0, null)).toMatchObject({ score: null, parts: [], message: 'The Librarian has not checked the Brain yet.' });
    expect(brainHealth({ ...zero, waiting: 20 }, 0, 1).message).toBe('Mostly tidy. Biggest item: waiting for you (20).');
    expect(brainHealth({ ...zero, waiting: 20, stale: 100 }, 3, 1).message).toMatch(/^Needs some care\. Biggest item: not used in 90 days \(100\)\.$/);
  });
});
