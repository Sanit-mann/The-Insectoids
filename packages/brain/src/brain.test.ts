import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Brain, ConflictError, SecretError, TrustError, openBrain } from './index';

const user = { type: 'user' } as const;
const ant = { type: 'agent', id: 'Ant-07' } as const;

let brain: Brain;
let clock: number;

beforeEach(() => {
  clock = 1_000;
  let n = 0;
  brain = openBrain(':memory:', { now: () => clock, newId: () => `r${++n}` });
});

afterEach(() => brain.close());

describe('writing records and trust levels (Memory 01-D3)', () => {
  it('a user write is confirmed', () => {
    const { id, created } = brain.write({ kind: 'decision', shelf: 'site', title: 'Keep the brand', body: 'No rebrand.' }, user);
    expect(created).toBe(true);
    expect(brain.get(id)).toMatchObject({ kind: 'decision', trust: 'confirmed', version: 1, archived: false });
  });

  it('an agent fact starts unconfirmed', () => {
    const { id } = brain.write({ kind: 'fact', shelf: 'site', title: 'Brand font', body: 'Satoshi' }, ant);
    expect(brain.get(id)?.trust).toBe('unconfirmed');
  });

  it('an agent decision is only proposed', () => {
    const { id } = brain.write({ kind: 'decision', shelf: 'site', title: 'Use Astro', body: 'Static blog.' }, ant);
    expect(brain.get(id)?.trust).toBe('proposed');
  });

  it('an agent cannot mark its own fact or decision as confirmed', () => {
    expect(() => brain.write({ kind: 'fact', shelf: 's', title: 't', body: 'b', trust: 'confirmed' }, ant)).toThrow(TrustError);
    expect(() => brain.write({ kind: 'decision', shelf: 's', title: 't', body: 'b', trust: 'confirmed' }, ant)).toThrow(TrustError);
  });

  it('routine records from agents are recorded as-is', () => {
    const { id } = brain.write({ kind: 'outcome', shelf: 'site', title: 'Wave 1 verified', body: '3 of 3 passed' }, ant);
    expect(brain.get(id)?.trust).toBe('confirmed');
  });
});

describe('secrets never enter the Brain (Memory 01-E6)', () => {
  it('refuses a write that contains a secret and stores nothing', () => {
    expect(() =>
      brain.write({ kind: 'fact', shelf: 's', title: 'creds', body: 'key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789' }, ant),
    ).toThrow(SecretError);
    expect(brain.search('creds')).toEqual([]);
  });

  it('refuses an update that adds a secret', () => {
    const { id } = brain.write({ kind: 'fact', shelf: 's', title: 'note', body: 'safe' }, user);
    expect(() => brain.update(id, { body: 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789' }, user)).toThrow(SecretError);
    expect(brain.get(id)?.body).toBe('safe');
  });
});

describe('no duplicates (Memory 01-E5)', () => {
  it('writing the same record twice returns the existing one', () => {
    const a = brain.write({ kind: 'fact', shelf: 'site', title: 'Brand font', body: 'Satoshi' }, ant);
    const b = brain.write({ kind: 'fact', shelf: 'site', title: '  brand FONT ', body: 'Satoshi' }, ant);
    expect(b).toEqual({ id: a.id, created: false });
  });

  it('the same text on another shelf is a separate record', () => {
    const a = brain.write({ kind: 'fact', shelf: 'site', title: 'Brand font', body: 'Satoshi' }, ant);
    const b = brain.write({ kind: 'fact', shelf: 'blog', title: 'Brand font', body: 'Satoshi' }, ant);
    expect(b.id).not.toBe(a.id);
    expect(b.created).toBe(true);
  });
});

describe('versions, never overwrite (Memory 01-D3, 01-D14)', () => {
  it('an update creates a new version and keeps the old one', () => {
    const { id } = brain.write({ kind: 'fact', shelf: 's', title: 'Price', body: '$10' }, user);
    clock = 2_000;
    expect(brain.update(id, { body: '$12' }, user)).toBe(2);
    expect(brain.get(id)).toMatchObject({ body: '$12', version: 2, updatedAt: 2_000 });
    expect(brain.history(id).map((v) => [v.version, v.body])).toEqual([
      [1, '$10'],
      [2, '$12'],
    ]);
  });

  it('an agent cannot silently change something the user confirmed', () => {
    const { id } = brain.write({ kind: 'decision', shelf: 's', title: 'Keep the brand', body: 'No rebrand.' }, user);
    expect(() => brain.update(id, { body: 'Rebrand everything.' }, ant)).toThrow(ConflictError);
    expect(brain.get(id)?.version).toBe(1);
  });

  it('a user can confirm an agent proposal', () => {
    const { id } = brain.write({ kind: 'decision', shelf: 's', title: 'Use Astro', body: 'Static blog.' }, ant);
    brain.update(id, { trust: 'confirmed' }, user);
    expect(brain.get(id)?.trust).toBe('confirmed');
  });
});

describe('archive, never delete (Memory 01, AIS-OS rule)', () => {
  it('archived records leave search but stay readable', () => {
    const { id } = brain.write({ kind: 'fact', shelf: 's', title: 'Old pricing', body: 'two plans' }, user);
    brain.archive(id, user);
    expect(brain.search('pricing')).toEqual([]);
    expect(brain.get(id)?.archived).toBe(true);
  });

  it('there is no delete operation', () => {
    expect('delete' in brain).toBe(false);
  });
});

describe('links: a graph from real connections only', () => {
  it('links two existing records and lists them from both sides', () => {
    const goal = brain.write({ kind: 'task', shelf: 's', title: 'Marketing site', body: 'Relaunch' }, user).id;
    const dec = brain.write({ kind: 'decision', shelf: 's', title: 'Keep the brand', body: 'No rebrand' }, user).id;
    brain.link(goal, dec, 'decided-by');
    expect(brain.links(goal)).toEqual([{ id: dec, rel: 'decided-by', direction: 'out' }]);
    expect(brain.links(dec)).toEqual([{ id: goal, rel: 'decided-by', direction: 'in' }]);
  });

  it('refuses a link to a record that does not exist', () => {
    const a = brain.write({ kind: 'fact', shelf: 's', title: 'a', body: 'a' }, user).id;
    expect(() => brain.link(a, 'missing', 'rel')).toThrow();
  });
});

describe('search and tiered reading (Memory 01-D7)', () => {
  it('finds a record by a pasted sentence with punctuation and file names', () => {
    const { id } = brain.write({ kind: 'task', shelf: 'site', title: 'Goal: Say hello: add a hello.txt and a README note', body: 'Say hello.' }, user);
    expect(brain.search('Say hello: add a hello.txt and a README note', { shelf: 'site' }).map((h) => h.id)).toEqual([id]);
    expect(brain.search('hello.txt', { shelf: 'site' }).map((h) => h.id)).toEqual([id]);
    expect(brain.search('... !!!', { shelf: 'site' })).toEqual([]);
  });

  beforeEach(() => {
    brain.write({ kind: 'decision', shelf: 'site', title: 'Use Astro for the blog', body: 'Static pages and Markdown posts.' }, user);
    brain.write({ kind: 'fact', shelf: 'site', title: 'Brand font', body: 'The brand font is Satoshi.' }, user);
    brain.write({ kind: 'fact', shelf: 'global', title: 'Writing voice', body: 'Short sentences, no hype.' }, user);
    brain.write({ kind: 'fact', shelf: 'other', title: 'Blog platform elsewhere', body: 'Ghost blog on another project.' }, user);
  });

  it('finds records by keyword', () => {
    const hits = brain.search('blog', { shelf: 'site' });
    expect(hits.map((h) => h.title)).toEqual(['Use Astro for the blog']);
  });

  it('a project shelf also sees the global shelf, never other projects', () => {
    const titles = brain.search('voice OR blog', { shelf: 'site' }).map((h) => h.title);
    expect(titles).toContain('Writing voice');
    expect(titles).not.toContain('Blog platform elsewhere');
  });

  it('filters by kind', () => {
    expect(brain.search('brand OR blog', { shelf: 'site', kinds: ['fact'] }).map((h) => h.title)).toEqual(['Brand font']);
  });

  it('a budgeted read stays within its token budget', () => {
    for (let i = 0; i < 40; i++) {
      brain.write({ kind: 'fact', shelf: 'site', title: `Blog note ${i}`, body: 'blog '.repeat(40) }, user);
    }
    const r = brain.read('blog', { shelf: 'site', tokenBudget: 200 });
    expect(Math.ceil(r.text.length / 4)).toBeLessThanOrEqual(200);
    expect(r.truncated).toBe(true);
    expect(r.ids.length).toBeGreaterThan(0);
  });

  it('the boot card is short and leads with confirmed decisions', () => {
    const card = brain.bootCard('site');
    expect(card).toContain('Use Astro for the blog');
    expect(card).not.toContain('Ghost blog');
    expect(Math.ceil(card.length / 4)).toBeLessThanOrEqual(300);
  });
});

describe('recent records (Brain screen browsing)', () => {
  it('lists the newest records on the shelf plus global, never other projects or archived ones', () => {
    const a = brain.write({ kind: 'task', shelf: 'site', title: 'A', body: 'a' }, user).id;
    clock += 10;
    const g = brain.write({ kind: 'fact', shelf: 'global', title: 'G', body: 'g' }, user).id;
    clock += 10;
    brain.write({ kind: 'task', shelf: 'shop', title: 'S', body: 's' }, user);
    const gone = brain.write({ kind: 'task', shelf: 'site', title: 'Old', body: 'o' }, user).id;
    brain.archive(gone, user);
    expect(brain.recent({ shelf: 'site' }).map((h) => h.id)).toEqual([g, a]);
    expect(brain.recent({ shelf: 'site', kinds: ['task'] }).map((h) => h.id)).toEqual([a]);
  });
});
