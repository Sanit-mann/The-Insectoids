import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXPORT_FOLDER_NAME, EXPORT_MARKER, SECRET_REMOVED } from '@insectoids/shared';
import { type Brain, type VaultBuild, buildObsidianVault, openBrain, writeObsidianVault } from './index';

const user = { type: 'user' } as const;
const GH_TOKEN = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const ANT_KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

let dir: string;
let file: string;
let brain: Brain;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'insectoids-obsidian-'));
  file = join(dir, 'brain.db');
  clock = Date.UTC(2026, 10, 14, 9, 0, 0);
  let n = 0;
  brain = openBrain(file, { now: () => clock, newId: () => `r${++n}` });
});

afterEach(() => {
  brain.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A second connection to the same database file, for planting what the Brain's write guard refuses. */
function raw(sql: string, ...params: Array<string | number>): void {
  const db = new DatabaseSync(file);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

const names = { p1: 'Shop site', p2: 'Shop site' } as Record<string, string>;
const build = (includeArchived = false): VaultBuild =>
  buildObsidianVault(brain, { includeArchived, now: clock, shelfName: (s) => names[s] ?? (s === 'global' ? 'Global' : s) });
const fileAt = (b: VaultBuild, path: string): string => {
  const f = b.files.find((x) => x.path === path);
  if (!f) throw new Error(`no file ${path} in ${b.files.map((x) => x.path).join(', ')}`);
  return f.content;
};

/** A tiny YAML reader for the subset the export writes: `key: scalar` and `key:` + `  - item` lists. */
function frontmatter(content: string): Record<string, unknown> {
  const lines = content.split('\n');
  expect(lines[0]).toBe('---');
  const end = lines.indexOf('---', 1);
  expect(end).toBeGreaterThan(0);
  const out: Record<string, unknown> = {};
  let list: unknown[] | undefined;
  const scalar = (v: string): unknown => {
    if (v.startsWith('"')) return JSON.parse(v) as unknown;
    expect(v).not.toMatch(/^['[{&*!|>%@`#]|: | #/);
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (v === 'true' || v === 'false') return v === 'true';
    return v;
  };
  for (const line of lines.slice(1, end)) {
    const item = /^ {2}- (.+)$/.exec(line);
    if (item?.[1] !== undefined) {
      expect(list).toBeDefined();
      list?.push(scalar(item[1]));
      continue;
    }
    const kv = /^([a-z_]+):(?: (.+))?$/.exec(line);
    expect(kv, `bad YAML line: ${line}`).not.toBeNull();
    const [, key = '', value] = kv ?? [];
    if (value === undefined) out[key] = list = [];
    else {
      list = undefined;
      out[key] = scalar(value);
    }
  }
  return out;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('the vault layout (Phase 3 C2)', () => {
  it('writes one note per record in <shelf>/<kind plural>/<title>.md, sorted', () => {
    brain.write({ kind: 'fact', shelf: 'global', title: 'Hosting provider', body: 'Fly.io' }, user);
    brain.write({ kind: 'decision', shelf: 'p1', title: 'Use Stripe', body: 'For payments.' }, user);
    brain.write({ kind: 'agent_memory', shelf: 'p1', title: 'Checkout quirks', body: 'Retry once.' }, user);
    brain.write({ kind: 'lesson', shelf: 'global', title: 'Run the tests first', body: 'Always.' }, user);
    const b = build();
    expect(b.files.map((f) => f.path)).toEqual([
      'Global/Facts/Hosting provider.md',
      'Global/Lessons/Run the tests first.md',
      'Shop site/Agent memories/Checkout quirks.md',
      'Shop site/Decisions/Use Stripe.md',
    ]);
    expect(b).toMatchObject({ notes: 4, links: 0, shelves: ['Global', 'Shop site'], redacted: 0, skipped: 0 });
    expect(fileAt(b, 'Global/Facts/Hosting provider.md')).toContain('\nFly.io\n');
    expect(build()).toEqual(b);
  });

  it('defaults: global is "Global", other shelves use their id', () => {
    brain.write({ kind: 'task', shelf: 'proj-9', title: 'Ship it', body: 'soon' }, user);
    brain.write({ kind: 'update', shelf: 'global', title: 'Weekly', body: 'ok' }, user);
    const b = buildObsidianVault(brain, { includeArchived: false, now: clock });
    expect(b.files.map((f) => f.path)).toEqual(['Global/Updates/Weekly.md', 'proj-9/Tasks/Ship it.md']);
  });

  it('two shelves with the same name get separate folders', () => {
    brain.write({ kind: 'fact', shelf: 'p1', title: 'A', body: 'a' }, user);
    brain.write({ kind: 'fact', shelf: 'p2', title: 'B', body: 'b' }, user);
    expect(build().files.map((f) => f.path)).toEqual(['Shop site (2)/Facts/B.md', 'Shop site/Facts/A.md']);
  });
});

describe('frontmatter', () => {
  it('is valid YAML with quoted strings, ISO dates and the tags', () => {
    const { id } = brain.write(
      { kind: 'fact', shelf: 'global', title: 'He said: "yes" #1', body: 'body', source: 'https://example.com/a?b=1#c', confidence: 0.8 },
      user,
    );
    const b = build();
    expect(b.files).toHaveLength(1);
    const f = b.files[0];
    expect(f?.path).toBe('Global/Facts/He said yes 1.md');
    const fm = frontmatter(f?.content ?? '');
    expect(fm).toMatchObject({
      id,
      kind: 'fact',
      shelf: 'Global',
      status: 'current',
      trust: 'confirmed',
      owner: 'user',
      source: 'https://example.com/a?b=1#c',
      version: 1,
      confidence: 0.8,
      tags: ['insectoids/fact', 'insectoids/trust/confirmed'],
      aliases: ['He said: "yes" #1'],
    });
    for (const k of ['created', 'updated', 'valid_from']) expect(fm[k]).toMatch(ISO);
    expect(fm.created).toBe(new Date(clock).toISOString());
    expect(fm).not.toHaveProperty('redacted');
  });

  it('quotes strings YAML would read as something else', () => {
    brain.write({ kind: 'fact', shelf: 'global', title: 'true', body: 'x', source: '123' }, user);
    const fm = frontmatter(build().files[0]?.content ?? '');
    expect(fm.source).toBe('123');
    expect(build().files[0]?.content).toContain('source: "123"');
  });
});

describe('links', () => {
  it('writes outgoing links in words, and every [[link]] resolves to a note in the export', () => {
    const old = brain.write({ kind: 'fact', shelf: 'global', title: 'Host is Heroku', body: 'old' }, user);
    const now = brain.write({ kind: 'fact', shelf: 'global', title: 'Host is Fly', body: 'new', supersedes: old.id }, user);
    const dep = brain.write({ kind: 'task', shelf: 'p1', title: 'Deploy [prod] | fast', body: 'x' }, user);
    brain.link(dep.id, now.id, 'depends_on');

    const current = build();
    expect(fileAt(current, 'Global/Facts/Host is Fly.md')).toContain('## Links\n\n- Replaces: Host is Heroku (not exported)\n');
    expect(fileAt(current, 'Shop site/Tasks/Deploy prod fast.md')).toContain('- Depends on: [[Host is Fly]]');
    expect(current.links).toBe(1);

    const all = build(true);
    expect(fileAt(all, 'Global/Facts/Host is Fly.md')).toContain('- Replaces: [[Host is Heroku]]');
    const oldNote = fileAt(all, 'Global/Facts/Host is Heroku.md');
    expect(oldNote).toContain('- Replaced by: [[Host is Fly]]');
    expect(frontmatter(oldNote)).toMatchObject({ status: 'superseded', tags: expect.arrayContaining(['insectoids/archived']) as unknown });
    expect(all.links).toBe(3);

    // A link to a note whose title had to change shows the title.
    const b2 = brain.write({ kind: 'decision', shelf: 'p1', title: 'Why: speed', body: 'y' }, user);
    brain.link(dep.id, b2.id, 'explained_by');
    expect(fileAt(build(), 'Shop site/Tasks/Deploy prod fast.md')).toContain('- Explained by: [[Why speed|Why: speed]]');

    for (const b of [current, all, build()]) {
      const fileNames = new Set(b.files.map((f) => f.path.split('/').pop()?.replace(/\.md$/, '')));
      for (const f of b.files) {
        for (const m of f.content.matchAll(/\[\[([^\]|]+)/g)) expect(fileNames.has(m[1]), `${f.path} -> ${m[1]}`).toBe(true);
      }
    }
  });
});

describe('secrets are never written', () => {
  it('removes a planted secret from the title, body and source and marks the note redacted', () => {
    // The Brain refuses secrets in title, body and source, so plant them through a second connection to the database file.
    const { id } = brain.write({ kind: 'fact', shelf: 'global', title: 'Deploy notes', body: 'safe', source: 'run notes' }, user);
    raw('UPDATE records SET title = ?, body = ?, source = ? WHERE id = ?', `Key ${ANT_KEY}`, `token ${GH_TOKEN}
DB_PASSWORD=hunter2hunter2 and API_KEY=${ANT_KEY}`, `run with ${GH_TOKEN}`, id);
    const b = build();
    expect(b.redacted).toBe(1);
    expect(b.skipped).toBe(0);
    const f = b.files[0];
    expect(f?.path).toBe('Global/Facts/Key secret removed.md');
    const text = b.files.map((x) => `${x.path}\n${x.content}`).join('\n');
    for (const s of [GH_TOKEN, ANT_KEY, 'hunter2', 'sk-ant', 'ghp_']) expect(text).not.toContain(s);
    const fm = frontmatter(f?.content ?? '');
    expect(fm).toMatchObject({ redacted: true, source: `run with ${SECRET_REMOVED}`, aliases: [`Key ${SECRET_REMOVED}`] });
    expect(f?.content).toContain(`token ${SECRET_REMOVED}\n${SECRET_REMOVED} and ${SECRET_REMOVED}`);
  });

  it('leaves out a note that still matches after redaction, and drops links to it', () => {
    const a = brain.write({ kind: 'fact', shelf: 'global', title: 'Odd owner', body: 'b' }, user);
    const c = brain.write({ kind: 'fact', shelf: 'global', title: 'Points at it', body: 'c' }, user);
    brain.link(c.id, a.id, 'relates_to');
    // owner isn't redacted (it is an agent id), so a secret there survives redaction; plant it directly.
    raw('UPDATE records SET owner = ? WHERE id = ?', `agent:${GH_TOKEN}`, a.id);
    const b = build();
    expect(b).toMatchObject({ notes: 1, skipped: 1, links: 0 });
    expect(b.files.map((f) => f.path)).toEqual(['Global/Facts/Points at it.md']);
    expect(b.files[0]?.content).not.toContain('Odd owner');
    expect(b.files[0]?.content).not.toContain('## Links');
  });
});

describe('file names', () => {
  it('strips unsafe characters, avoids reserved names and trailing dots, and numbers collisions', () => {
    let n = 0;
    const t = (title: string, shelf = 'global'): void => {
      brain.write({ kind: 'fact', shelf, title, body: `note ${++n}` }, user);
    };
    t('a/b: c? *d* <e> [f] #g ^h |i| "j" \\k');
    t('CON');
    t('nul.txt');
    t('Ends with dots...');
    t('.hidden');
    t('###');
    t('x'.repeat(200));
    t('Pricing');
    t('pricing', 'p1');
    t('Pricing', 'p1');
    const paths = build().files.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'Global/Facts/a b c d e f g h i j k.md',
        'Global/Facts/CON_.md',
        'Global/Facts/nul_.txt.md',
        'Global/Facts/Ends with dots.md',
        'Global/Facts/hidden.md',
        'Global/Facts/Untitled.md',
        `Global/Facts/${'x'.repeat(120)}.md`,
        'Global/Facts/Pricing.md',
        // Same title ignoring case: unique across the vault (Windows and [[links]] ignore case); ties by id.
        'Shop site/Facts/Pricing (2).md',
        'Shop site/Facts/pricing (3).md',
      ]),
    );
    expect(paths).toHaveLength(10);
    const second = fileAt(build(), 'Shop site/Facts/pricing (3).md');
    expect(frontmatter(second).aliases).toEqual(['pricing']);
  });
});

describe('archived records', () => {
  it('are left out by default and included, tagged, with includeArchived', () => {
    brain.write({ kind: 'fact', shelf: 'global', title: 'Kept', body: 'k' }, user);
    const gone = brain.write({ kind: 'fact', shelf: 'global', title: 'Gone', body: 'g' }, user);
    brain.archive(gone.id, user);
    expect(build().files.map((f) => f.path)).toEqual(['Global/Facts/Kept.md']);
    const all = build(true);
    expect(all.files.map((f) => f.path)).toEqual(['Global/Facts/Gone.md', 'Global/Facts/Kept.md']);
    expect(frontmatter(fileAt(all, 'Global/Facts/Gone.md'))).toMatchObject({ status: 'archived', tags: ['insectoids/fact', 'insectoids/trust/confirmed', 'insectoids/archived'] });
  });
});

describe('writing the vault', () => {
  const vault = (): string => join(dir, 'out', EXPORT_FOLDER_NAME);

  it('writes the notes, a README and the marker', () => {
    brain.write({ kind: 'fact', shelf: 'global', title: 'Hosting provider', body: 'Fly.io' }, user);
    mkdirSync(join(dir, 'out'));
    const { path } = writeObsidianVault(join(dir, 'out'), build(), { now: clock });
    expect(path).toBe(vault());
    expect(readFileSync(join(path, 'Global', 'Facts', 'Hosting provider.md'), 'utf8')).toContain('Fly.io');
    const readme = readFileSync(join(path, 'README.md'), 'utf8');
    expect(readme).toContain('read-only copy');
    expect(readme).toContain('do not flow back');
    expect(readme).toContain('- Notes: 1');
    expect(readme).toContain('- Global: 1 note');
    const marker = JSON.parse(readFileSync(join(path, EXPORT_MARKER), 'utf8')) as unknown;
    expect(marker).toEqual({ version: 1, exportedAt: clock, files: ['Global/Facts/Hosting provider.md', 'README.md'] });
  });

  it('refuses a folder of that name that it did not make, and changes nothing', () => {
    mkdirSync(vault(), { recursive: true });
    writeFileSync(join(vault(), 'README.md'), 'mine');
    brain.write({ kind: 'fact', shelf: 'global', title: 'A', body: 'a' }, user);
    expect(() => writeObsidianVault(join(dir, 'out'), build(), { now: clock })).toThrow(/was not made by The Insectoids/);
    expect(readFileSync(join(vault(), 'README.md'), 'utf8')).toBe('mine');
    expect(existsSync(join(vault(), 'Global'))).toBe(false);
  });

  it('a second export removes notes that are gone but never touches the user’s own files', () => {
    const a = brain.write({ kind: 'fact', shelf: 'global', title: 'Stays', body: 'a' }, user);
    const b = brain.write({ kind: 'decision', shelf: 'p1', title: 'Goes away', body: 'b' }, user);
    const out = join(dir, 'out');
    writeObsidianVault(out, build(), { now: clock });
    writeFileSync(join(vault(), 'Global', 'Facts', 'My own note.md'), 'mine');
    writeFileSync(join(vault(), 'notes.txt'), 'mine too');

    brain.archive(b.id, user);
    brain.update(a.id, { body: 'a, changed' }, user);
    clock += 60_000;
    writeObsidianVault(out, build(), { now: clock });

    expect(existsSync(join(vault(), 'Shop site', 'Decisions', 'Goes away.md'))).toBe(false);
    expect(existsSync(join(vault(), 'Shop site'))).toBe(false);
    expect(readFileSync(join(vault(), 'Global', 'Facts', 'Stays.md'), 'utf8')).toContain('a, changed');
    expect(readFileSync(join(vault(), 'Global', 'Facts', 'My own note.md'), 'utf8')).toBe('mine');
    expect(readFileSync(join(vault(), 'notes.txt'), 'utf8')).toBe('mine too');
    const marker = JSON.parse(readFileSync(join(vault(), EXPORT_MARKER), 'utf8')) as { exportedAt: number; files: string[] };
    expect(marker).toEqual({ version: 1, exportedAt: clock, files: ['Global/Facts/Stays.md', 'README.md'] });
  });

  it('refuses to replace a user file that has the same name as a new note', () => {
    const out = join(dir, 'out');
    writeObsidianVault(out, build(), { now: clock });
    mkdirSync(join(vault(), 'Global', 'Facts'), { recursive: true });
    writeFileSync(join(vault(), 'Global', 'Facts', 'New one.md'), 'mine');
    brain.write({ kind: 'fact', shelf: 'global', title: 'New one', body: 'n' }, user);
    expect(() => writeObsidianVault(out, build(), { now: clock })).toThrow(/didn't make would be replaced/);
    expect(readFileSync(join(vault(), 'Global', 'Facts', 'New one.md'), 'utf8')).toBe('mine');
  });

  it('never removes paths outside the folder even if the marker lists them', () => {
    const out = join(dir, 'out');
    writeObsidianVault(out, build(), { now: clock });
    writeFileSync(join(dir, 'outside.txt'), 'keep');
    writeFileSync(join(vault(), EXPORT_MARKER), JSON.stringify({ version: 1, exportedAt: 0, files: ['../../outside.txt', 'README.md'] }));
    writeObsidianVault(out, build(), { now: clock });
    expect(readFileSync(join(dir, 'outside.txt'), 'utf8')).toBe('keep');
  });
});
