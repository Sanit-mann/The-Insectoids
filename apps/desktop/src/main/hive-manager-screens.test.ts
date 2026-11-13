import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { demoEngine } from '@insectoids/harness';
import { BrainDashboardViewSchema, BrainEditResultSchema, BrainGraphViewSchema, HiveSnapshotSchema } from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HiveManager } from '../brain-host/hive-manager';

/** Brain screens in the host (Phase 2 B5; Memory 01-D10–D13): graph, dashboard, the user's safe edit, archive. */
const libraryDir = fileURLToPath(new URL('../../../../library', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const ant = { type: 'agent', id: 'Ant-1' } as const;

let root: string;
let repo: string;
let brain: Brain;
let manager: HiveManager | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-screens-hm-'));
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

async function make(o: { seed?: boolean } = {}): Promise<HiveManager> {
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
    ...(o.seed ? { seedBrainForE2E: true } : {}),
  });
  await manager.init();
  return manager;
}

const activity = (m: HiveManager) => HiveSnapshotSchema.parse(m.snapshot()).activity.map((a) => a.message);

describe('the user edits a record (01-D12)', () => {
  it('saves a new version, confirmed, and says so', async () => {
    const m = await make();
    const id = brain.write({ kind: 'fact', shelf: 'site', title: 'Port', body: '3000' }, ant).id;
    const r = BrainEditResultSchema.parse(m.brainEdit({ id, baseVersion: 1, title: 'Dev port', body: '3001', summary: 'The dev server port.' }));
    expect(r).toEqual({ status: 'saved', version: 2 });
    expect(brain.get(id)).toMatchObject({ title: 'Dev port', body: '3001', summary: 'The dev server port.', trust: 'confirmed', version: 2 });
    expect(brain.history(id).at(-1)).toMatchObject({ changedBy: 'user', change: 'update' });
    expect(activity(m).some((a) => a.includes('You edited "Dev port"'))).toBe(true);
  });

  it('an empty summary clears it', async () => {
    const m = await make();
    const id = brain.write({ kind: 'update', shelf: 'site', title: 'Note', body: 'b', summary: 'old summary' }, ant).id;
    expect(m.brainEdit({ id, baseVersion: 1, title: 'Note', body: 'b', summary: '  ' }).status).toBe('saved');
    expect(brain.get(id)?.summary).toBeNull();
  });

  it('shows a conflict, and saves nothing, when an agent changed it after the edit started', async () => {
    const m = await make();
    const id = brain.write({ kind: 'fact', shelf: 'site', title: 'Port', body: '3000' }, ant).id;
    brain.update(id, { body: '4000' }, ant);
    const r = BrainEditResultSchema.parse(m.brainEdit({ id, baseVersion: 1, title: 'Port', body: '3001', summary: null }));
    expect(r).toMatchObject({ status: 'conflict', current: { version: 2, title: 'Port', body: '4000', summary: null, changedBy: 'Ant-1' } });
    expect(brain.get(id)).toMatchObject({ body: '4000', version: 2, trust: 'unconfirmed' });
    // Starting again from the version the user has now seen saves.
    expect(m.brainEdit({ id, baseVersion: 2, title: 'Port', body: '3001', summary: null })).toEqual({ status: 'saved', version: 3 });
  });

  it('refuses archived records, unknown records and secrets in plain words', async () => {
    const m = await make();
    const id = brain.write({ kind: 'update', shelf: 'site', title: 'Old', body: 'b' }, ant).id;
    brain.archive(id, { type: 'user' });
    expect(m.brainEdit({ id, baseVersion: 2, title: 'Old', body: 'c', summary: null })).toEqual({
      status: 'error',
      message: 'This record is archived. Bring it back first.',
    });
    expect(m.brainEdit({ id: 'nope', baseVersion: 1, title: 'x', body: 'y', summary: null })).toMatchObject({ status: 'error' });
    const other = brain.write({ kind: 'update', shelf: 'site', title: 'Keys', body: 'none' }, ant).id;
    const r = m.brainEdit({ id: other, baseVersion: 1, title: 'Keys', body: 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', summary: null });
    expect(r).toMatchObject({ status: 'error', message: expect.stringMatching(/Vault/) });
    expect(brain.get(other)?.body).toBe('none');
  });

  it('archiveRecord archives as the user ("by you"), and restore brings it back', async () => {
    const m = await make();
    const id = brain.write({ kind: 'update', shelf: 'site', title: 'Draft plan', body: 'b' }, ant).id;
    expect(await m.command({ type: 'archiveRecord', id })).toEqual({ ok: true });
    expect(brain.get(id)).toMatchObject({ archived: true, archivedReason: 'by you' });
    expect(activity(m).some((a) => a.startsWith('Archived "Draft plan"'))).toBe(true);
    expect(await m.command({ type: 'restoreRecord', id })).toEqual({ ok: true });
    expect(brain.get(id)?.archived).toBe(false);
    expect(await m.command({ type: 'archiveRecord', id: 'nope' })).toMatchObject({ ok: false });
  });
});

describe('graph and dashboard', () => {
  it('graph scopes: the project (plus global), global alone, every shelf', async () => {
    const m = await make();
    const a = brain.write({ kind: 'decision', shelf: 'site', title: 'Use Astro', body: 'Static.' }, { type: 'user' }).id;
    const g = brain.write({ kind: 'fact', shelf: 'global', title: 'Node 22', body: 'Node 22.' }, ant).id;
    const o = brain.write({ kind: 'update', shelf: 'elsewhere', title: 'Other', body: 'x' }, ant).id;
    brain.link(a, g, 'uses');
    const ids = (scope: 'project' | 'global' | 'all') => BrainGraphViewSchema.parse(m.brainGraph({ scope })).nodes.map((n) => n.id);
    expect(ids('project')).toEqual(expect.arrayContaining([a, g]));
    expect(ids('project')).not.toContain(o);
    expect(ids('global')).toEqual([g]);
    expect(ids('all')).toEqual(expect.arrayContaining([a, g, o]));
    expect(m.brainGraph({ scope: 'project' }).edges).toEqual([{ from: a, to: g, rel: 'uses' }]);
    expect(m.brainGraph({ scope: 'project', kinds: ['decision'] }).nodes.map((n) => n.id)).toEqual([a]);
  });

  it('the dashboard is for the open project and matches the shared schema', async () => {
    const m = await make();
    brain.write({ kind: 'decision', shelf: 'site', title: 'Use Astro', body: 'Static.' }, { type: 'user' });
    const d = BrainDashboardViewSchema.parse(m.brainDashboard());
    expect(d.shelf).toBe('site');
    expect(d.weeks).toHaveLength(8);
    expect(d.timeline[0]).toMatchObject({ title: 'Use Astro', change: 'create', changedBy: 'user' });
  });

  it('e2e seed: linked records for the graph, and an unconfirmed agent fact that can still change', async () => {
    const m = await make({ seed: true });
    const g = m.brainGraph({ scope: 'project' });
    const byTitle = (t: string) => g.nodes.find((n) => n.title === t);
    expect(g.edges.length).toBeGreaterThanOrEqual(3);
    const fact = byTitle('Order emails come from the shop address');
    expect(fact).toMatchObject({ kind: 'fact', trust: 'unconfirmed' });
    expect(byTitle('Take payments by card only')).toMatchObject({ trust: 'proposed' });
    // The B2 searches the earlier specs use still find exactly what they did.
    expect(brain.search('checkout stripe elements', { shelf: 'site' })).toHaveLength(1);
    expect(brain.search('hosting provider', { shelf: 'site' })).toHaveLength(1);
    // The conflict hook (e2e) changes it as an agent.
    const prev = process.env['INSECTOIDS_E2E'];
    process.env['INSECTOIDS_E2E'] = '1';
    try {
      m.e2eAgentEdit(fact!.id, 'Order emails are sent from orders@ instead.');
    } finally {
      if (prev === undefined) delete process.env['INSECTOIDS_E2E'];
      else process.env['INSECTOIDS_E2E'] = prev;
    }
    expect(brain.history(fact!.id).at(-1)).toMatchObject({ changedBy: 'e2e-agent' });
    expect(() => m.e2eAgentEdit(fact!.id, 'again')).toThrow(/end-to-end/);
  });
});
