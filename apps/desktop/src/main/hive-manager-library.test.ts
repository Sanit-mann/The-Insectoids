import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { demoEngine } from '@insectoids/harness';
import { CasteSchema, CasteViewSchema, HiveSnapshotSchema, LibraryItemDetailSchema, LibrarySearchResultSchema } from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HiveManager } from '../brain-host/hive-manager';

/** The Library in the host (Phase 2 C1; Capabilities 03-D3, D7, D8): castes, catalog, and skills on cards. */
const libraryDir = fileURLToPath(new URL('../../../../library', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let brain: Brain;
let manager: HiveManager | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-library-hm-'));
  repo = join(root, 'site');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'README.md'), '# Site\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  brain = openBrain(':memory:');
  manager = null;
});

afterEach(async () => {
  await manager?.dispose();
  await new Promise((r) => setTimeout(r, 50));
  brain.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function make(): Promise<HiveManager> {
  manager = new HiveManager({
    brain,
    tokens: null,
    doors: null,
    userDataDir: join(root, 'userData'),
    libraryDir,
    engine: 'fake',
    engineOverride: demoEngine({ queenMs: 5, insectMs: 20, inspectorMs: 5 }),
    project: repo,
    push: () => {},
    tickMs: 20,
    seed: 1,
    geminiDetect: async () => ({ status: 'missing' }),
  });
  await manager.init();
  return manager;
}

async function until<T>(what: string, read: () => T | undefined | null | false, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const snap = (m: HiveManager) => HiveSnapshotSchema.parse(m.snapshot());

describe('castes (03-D3)', () => {
  it('all 8, each with a role line, default skills and a network policy', async () => {
    const m = await make();
    const castes = CasteViewSchema.array().parse(m.libraryCastes());
    expect(castes.map((c) => c.caste)).toEqual(CasteSchema.options);
    for (const c of castes) {
      expect(c.enabled).toBe(true);
      expect(c.role.length).toBeGreaterThan(10);
      expect(c.defaultSkills).toContain('executing-a-task-card');
    }
    expect(castes.find((c) => c.caste === 'researcher')).toMatchObject({ label: 'Researcher', network: 'web' });
    expect(castes.find((c) => c.caste === 'coder')).toMatchObject({ network: 'docs', defaultSkills: ['executing-a-task-card', 'coding-discipline'] });
  });
});

describe('the catalog (03-D8)', () => {
  it('is synced into the Brain at start and searchable with filters and status counts', async () => {
    const m = await make();
    const all = LibrarySearchResultSchema.parse(m.librarySearch({}));
    expect(all.total).toBeGreaterThan(900);
    expect(all.counts.active + all.counts.ready).toBe(65);
    expect(all.counts.dormant).toBeGreaterThan(800);
    expect(all.counts.draft).toBe(0);
    expect(all.items[0]!.status).toBe('active');

    const found = LibrarySearchResultSchema.parse(m.librarySearch({ query: 'accessibility', statuses: ['ready'] }));
    expect(found.items.map((i) => i.name)).toContain('accessibility');
    const docs = LibrarySearchResultSchema.parse(m.librarySearch({ caste: 'documenter', kinds: ['skill'], statuses: ['active', 'ready'], limit: 200 }));
    expect(docs.items.map((i) => i.name)).toEqual(expect.arrayContaining(['technical-writing', 'writing-guidelines', 'executing-a-task-card']));
  });

  it('an item shows its text when on disk, never for a dormant entry', async () => {
    const m = await make();
    const ready = LibraryItemDetailSchema.parse(m.libraryItem('accessibility'));
    expect(ready.item).toMatchObject({ kind: 'skill', status: 'ready', safety: 'vetted' });
    expect(ready.body).toBeTruthy();
    expect(ready.body!.startsWith('---')).toBe(false);
    const dormantName = LibrarySearchResultSchema.parse(m.librarySearch({ statuses: ['dormant'], limit: 1 })).items[0]!.name;
    const dormant = LibraryItemDetailSchema.parse(m.libraryItem(dormantName));
    expect(dormant.item).toMatchObject({ status: 'dormant', safety: 'unscanned' });
    expect(dormant.body).toBeNull();
    expect(m.libraryItem('no-such-item')).toBeNull();
  });
});

describe('a goal across three castes, with skills on its cards (C1 done-when)', () => {
  it('runs coder, tester and documenter cards; each card shows the skills it carried; usage is counted', async () => {
    const m = await make();
    await m.command({ type: 'submitGoal', text: 'Write the welcome docs' });
    const cards = await until('three verified cards', () => {
      const cs = snap(m).cards;
      return cs.length === 3 && cs.every((c) => c.status === 'done') && cs;
    });
    expect(cards.map((c) => c.caste).sort()).toEqual(['coder', 'documenter', 'tester']);
    const byCaste = new Map(cards.map((c) => [c.caste, c]));
    expect(byCaste.get('documenter')!.skills).toEqual(expect.arrayContaining(['executing-a-task-card', 'technical-writing', 'writing-guidelines']));
    expect(byCaste.get('coder')!.skills).toContain('surgical-patch');
    for (const c of cards) expect(c.skills.length).toBeLessThanOrEqual(5);

    const detail = LibraryItemDetailSchema.parse(m.libraryItem('writing-guidelines'));
    expect(detail.item.usage).toMatchObject({ uses: 1, passed: 1, failed: 0 });
    expect(detail.recentCards[0]).toMatchObject({ title: 'Document welcome.txt', outcome: 'passed' });
  });
});
