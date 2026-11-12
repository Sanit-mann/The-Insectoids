import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Brain, ConflictError, DECAY, SecretError, TrustError, cardReadKey, importance, openBrain, rankScore } from './index';

const user = { type: 'user' } as const;
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

describe('importance (01-E7): one formula, table-tested', () => {
  const base = { trust: 'confirmed' as const, confidence: null, reads: 0, helped: 0, lastUsedAt: null, updatedAt: 0 };
  it.each([
    ['fresh, unused, confirmed', base, 0, 0.5],
    ['one half-life old', base, 30 * DAY, 0.25],
    ['two half-lives old', base, 60 * DAY, 0.125],
    ['read 32 times today', { ...base, reads: 32 }, 0, 0.8],
    ['helped once', { ...base, helped: 1 }, 0, 0.6],
    ['read 32 times, helped 3 times', { ...base, reads: 32, helped: 3 }, 0, 0.975],
    ['unconfirmed weighs 0.8', { ...base, trust: 'unconfirmed' as const }, 0, 0.4],
    ['proposed weighs 0.7', { ...base, trust: 'proposed' as const }, 0, 0.35],
    ['confidence scales it', { ...base, confidence: 0.5 }, 0, 0.25],
    ['last use counts as freshness', { ...base, lastUsedAt: 60 * DAY }, 60 * DAY, 0.5],
  ])('%s', (_label, input, now, expected) => {
    expect(importance(input, now)).toBeCloseTo(expected, 3);
  });

  it('ranking keeps relevance first: importance scales a score by 0.7..1.0', () => {
    expect(rankScore(1, 0)).toBeCloseTo(0.7);
    expect(rankScore(1, 1)).toBeCloseTo(1);
  });
});

describe('use tracking', () => {
  it('reads count only when handed out (read, boot card, noteRead); search alone does not', () => {
    const { id } = brain.write({ kind: 'decision', shelf: 'site', title: 'Use Tailwind', body: 'Tailwind 4 only.' }, user);
    brain.search('tailwind', { shelf: 'site' });
    expect(brain.get(id)!.reads).toBe(0);
    brain.read('tailwind', { shelf: 'site' });
    brain.bootCard('site');
    brain.noteRead([id]);
    expect(brain.get(id)).toMatchObject({ reads: 3, lastUsedAt: clock });
  });

  it('a passed card attempt credits what its runs read, once', () => {
    const { id } = brain.write({ kind: 'fact', shelf: 'site', title: 'Port', body: 'The dev server runs on port 5173.' }, user);
    const key = cardReadKey('G.C-01', 0);
    brain.read('dev server port', { shelf: 'site', readKey: key });
    expect(brain.creditHelped(key)).toBe(1);
    expect(brain.creditHelped(key)).toBe(0);
    expect(brain.get(id)!.helped).toBe(1);
  });

  it('between equally relevant records, the more used one ranks first', () => {
    const a = brain.write({ kind: 'update', shelf: 'site', title: 'Deploy note alpha', body: 'deploy pipeline' }, ant).id;
    const b = brain.write({ kind: 'update', shelf: 'site', title: 'Deploy note beta', body: 'deploy pipeline' }, ant).id;
    expect(brain.search('deploy pipeline', { shelf: 'site' }).map((h) => h.id)).toEqual([a, b]);
    for (let i = 0; i < 10; i++) brain.noteRead([b]);
    expect(brain.search('deploy pipeline', { shelf: 'site' }).map((h) => h.id)).toEqual([b, a]);
  });
});

describe('time-aware facts (01-E9)', () => {
  it('superseding keeps the old one as history; default search shows only the current one', () => {
    const old = brain.write({ kind: 'fact', shelf: 'site', title: 'Hosting', body: 'The site is hosted on Netlify.' }, ant).id;
    clock += DAY;
    const r = brain.write({ kind: 'fact', shelf: 'site', title: 'Hosting', body: 'The site moved to Vercel hosting.', supersedes: old }, ant);
    expect(r).toMatchObject({ created: true });
    expect(brain.get(old)).toMatchObject({ validTo: clock, supersededBy: r.id, archived: false });
    expect(brain.get(r.id)).toMatchObject({ validFrom: clock, validTo: null });
    expect(brain.links(r.id)).toContainEqual({ id: old, rel: 'supersedes', direction: 'out' });
    expect(brain.search('hosting', { shelf: 'site' }).map((h) => [h.id, h.status])).toEqual([[r.id, 'current']]);
    expect(new Map(brain.search('hosting', { shelf: 'site', includeHistory: true }).map((h) => [h.id, h.status]))).toEqual(
      new Map([[r.id, 'current'], [old, 'superseded']]),
    );
    expect(brain.read('hosting', { shelf: 'site' }).ids).toEqual([r.id]);
    expect(brain.history(old).at(-1)).toMatchObject({ change: 'supersede' });
  });

  it('a chain stays a chain: each step supersedes only the current record', () => {
    const a = brain.write({ kind: 'fact', shelf: 'site', title: 'Node', body: 'Node 20.' }, ant).id;
    const b = brain.write({ kind: 'fact', shelf: 'site', title: 'Node', body: 'Node 22.', supersedes: a }, ant).id;
    expect(() => brain.write({ kind: 'fact', shelf: 'site', title: 'Node', body: 'Node 24.', supersedes: a }, ant)).toThrow(/already superseded/);
    const c = brain.write({ kind: 'fact', shelf: 'site', title: 'Node', body: 'Node 24.', supersedes: b }, ant).id;
    expect(brain.get(b)!.supersededBy).toBe(c);
  });

  it('an agent cannot supersede what the user confirmed: its record becomes a proposal', () => {
    const mine = brain.write({ kind: 'decision', shelf: 'site', title: 'Keep the brand', body: 'No rebrand.' }, user).id;
    const r = brain.write({ kind: 'decision', shelf: 'site', title: 'Rebrand', body: 'Rebrand to blue.', supersedes: mine }, ant);
    expect(r.note).toMatch(/confirmed by the user.*proposal/);
    expect(brain.get(mine)).toMatchObject({ validTo: null, supersededBy: null });
    expect(brain.get(r.id)!.trust).toBe('proposed');
    expect(brain.links(r.id)).toContainEqual({ id: mine, rel: 'proposes_to_supersede', direction: 'out' });
    expect(() => brain.supersede(mine, r.id, ant)).toThrow(ConflictError);
  });

  it('only on the same shelf, and the secrets guard still applies', () => {
    const other = brain.write({ kind: 'fact', shelf: 'shop', title: 'Port', body: 'Port 3000.' }, ant).id;
    expect(() => brain.write({ kind: 'fact', shelf: 'site', title: 'Port', body: 'Port 3001.', supersedes: other }, ant)).toThrow(/shelf/);
    const mine = brain.write({ kind: 'fact', shelf: 'site', title: 'Key', body: 'Old note.' }, ant).id;
    expect(() => brain.write({ kind: 'fact', shelf: 'site', title: 'Key', body: 'AKIAABCDEFGHIJKLMNOP', supersedes: mine }, ant)).toThrow(SecretError);
  });
});

describe('near-duplicates (01-E5)', () => {
  const note = 'The checkout page uses Stripe Elements for card entry and shows the total before payment.';

  it("an agent's near-duplicate of an agent record is folded in as a new version", () => {
    const first = brain.write({ kind: 'update', shelf: 'site', title: 'Checkout', body: note }, ant).id;
    const reworded = 'the Checkout page uses Stripe elements for card entry, and shows the total before payment';
    const r = brain.write({ kind: 'update', shelf: 'site', title: 'Checkout', body: reworded }, ant);
    expect(r).toMatchObject({ id: first, created: false, merged: true });
    expect(r.note).toMatch(/Already known as/);
    expect(brain.get(first)).toMatchObject({ version: 2, body: reworded });
    expect(brain.history(first).at(-1)).toMatchObject({ change: 'merge' });
    const folded = brain.links(first).find((l) => l.rel === 'merged_into');
    expect(folded).toMatchObject({ direction: 'in' });
    expect(brain.get(folded!.id)).toMatchObject({ archived: true, archivedReason: `merged into ${first}` });
    expect(brain.search('checkout stripe', { shelf: 'site' })).toHaveLength(1);
  });

  it("never merges into what the user confirmed: the user's record is untouched", () => {
    const mine = brain.write({ kind: 'fact', shelf: 'site', title: 'Checkout', body: note }, user).id;
    const r = brain.write({ kind: 'fact', shelf: 'site', title: 'Checkout', body: `${note} Really.` }, ant);
    expect(r).toMatchObject({ id: mine, created: false, merged: false });
    expect(r.note).toMatch(/user confirmed; nothing changed/);
    expect(brain.get(mine)!.version).toBe(1);
  });

  it.each([
    ['a different number', 'The dev server runs on port 3000 in development mode.', 'The dev server runs on port 3001 in development mode.'],
    ['a different fact', 'The checkout page uses Stripe Elements for card entry.', 'The checkout page uses PayPal buttons for card entry.'],
    ['a different kind of statement', 'Tests run with Vitest in watch mode on save.', 'Lint runs with ESLint in watch mode on save.'],
  ])('near-misses stay separate: %s', (_label, a, b) => {
    const x = brain.write({ kind: 'update', shelf: 'site', title: 'Note', body: a }, ant);
    const y = brain.write({ kind: 'update', shelf: 'site', title: 'Note', body: b }, ant);
    expect(y.created).toBe(true);
    expect(y.id).not.toBe(x.id);
  });

  it('with meaning vectors, cosine ≥ 0.95 decides', () => {
    const v = (x: number) => Float32Array.from([x, Math.sqrt(1 - x * x), 0]);
    const first = brain.write({ kind: 'update', shelf: 'site', title: 'Login', body: 'Sign-in uses magic links.', vector: { vector: v(1), model: 'm' } }, ant).id;
    const near = brain.write({ kind: 'update', shelf: 'site', title: 'Auth', body: 'Users log in with an emailed link.', vector: { vector: v(0.99), model: 'm' } }, ant);
    expect(near).toMatchObject({ id: first, merged: true });
    const far = brain.write({ kind: 'update', shelf: 'site', title: 'Billing', body: 'Invoices go out monthly.', vector: { vector: v(0.5), model: 'm' } }, ant);
    expect(far.created).toBe(true);
  });
});

describe('decay (01-E7)', () => {
  it('fades only unused, unimportant agent notes, and says why', () => {
    const agentNote = brain.write({ kind: 'update', shelf: 'site', title: 'Tried a thing', body: 'Scratch note.' }, ant).id;
    const userNote = brain.write({ kind: 'update', shelf: 'site', title: 'My note', body: 'Keep this.' }, user).id;
    const decision = brain.write({ kind: 'decision', shelf: 'site', title: 'Proposed', body: 'Maybe.' }, ant).id;
    const task = brain.write({ kind: 'task', shelf: 'site', title: 'Old task', body: 'Do it.' }, ant).id;
    const usedNote = brain.write({ kind: 'update', shelf: 'site', title: 'Popular', body: 'Read a lot.' }, ant).id;
    for (let i = 0; i < 40; i++) brain.noteRead([usedNote]);
    const later = clock + 61 * DAY;
    const faded = brain.fade({ now: later });
    expect(faded.map((f) => f.id)).toEqual([agentNote]);
    expect(brain.get(agentNote)).toMatchObject({ archived: true, archivedReason: 'faded: unused for 61 days' });
    for (const id of [userNote, decision, task, usedNote]) expect(brain.get(id)!.archived).toBe(false);
  });

  it('agent facts fade only when still unconfirmed after 90 days; confirmed and user-edited ones never', () => {
    const unconfirmed = brain.write({ kind: 'fact', shelf: 'site', title: 'Guess', body: 'Probably React 18.' }, ant).id;
    const confirmed = brain.write({ kind: 'fact', shelf: 'site', title: 'Checked', body: 'React 19.' }, ant).id;
    brain.update(confirmed, { trust: 'confirmed' }, user);
    const edited = brain.write({ kind: 'update', shelf: 'site', title: 'Edited by you', body: 'v1' }, ant).id;
    brain.update(edited, { body: 'v2 by the user' }, user);
    expect(brain.fade({ now: clock + 61 * DAY }).map((f) => f.id)).toEqual([]);
    expect(brain.fade({ now: clock + DECAY.factsDays * DAY + DAY }).map((f) => f.id)).toEqual([unconfirmed]);
  });

  it('only the user can bring a faded record back, as a new version', () => {
    const id = brain.write({ kind: 'update', shelf: 'site', title: 'Old', body: 'Scratch.' }, ant).id;
    brain.fade({ now: clock + 90 * DAY });
    expect(() => brain.unarchive(id, ant)).toThrow(TrustError);
    brain.unarchive(id, user);
    expect(brain.get(id)).toMatchObject({ archived: false, archivedReason: null });
    expect(brain.history(id).at(-1)).toMatchObject({ change: 'unarchive', changedBy: 'user' });
    expect(brain.search('scratch', { shelf: 'site' })).toHaveLength(1);
  });

  it('archived records show up only with includeHistory', () => {
    const id = brain.write({ kind: 'update', shelf: 'site', title: 'Gone', body: 'Faded note about widgets.' }, ant).id;
    brain.fade({ now: clock + 90 * DAY });
    expect(brain.search('widgets', { shelf: 'site' })).toEqual([]);
    expect(brain.search('widgets', { shelf: 'site', includeHistory: true })).toMatchObject([{ id, status: 'archived' }]);
    expect(brain.recent({ shelf: 'site', includeHistory: true })).toMatchObject([{ id, status: 'archived' }]);
    expect(brain.recent({ shelf: 'site' })).toEqual([]);
  });
});
