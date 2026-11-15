import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { demoEngine } from '@insectoids/harness';
import { BrainTimelineViewSchema, HIVE_IPC } from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HiveManager } from '../brain-host/hive-manager';

/** The Brain's timeline in the host and over IPC (Phase 4 A3): scope, the goal link, and the reply's shape. */
const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, arg: unknown) => Promise<unknown>>() }));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, arg: unknown) => Promise<unknown>) => electron.handlers.set(channel, fn) },
  dialog: { showOpenDialog: vi.fn() },
}));
const { registerHiveIpc } = await import('./hive-ipc');

const libraryDir = fileURLToPath(new URL('../../../../library', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const user = { type: 'user' } as const;
const ant = { type: 'agent', id: 'Ant-02' } as const;

let root: string;
let repo: string;
let brain: Brain;
let clock: number;
let manager: HiveManager | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-timeline-hm-'));
  repo = join(root, 'site');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'README.md'), '# Site\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  clock = 1_000_000;
  brain = openBrain(':memory:', { now: () => clock });
  manager = null;
  electron.handlers.clear();
});

afterEach(async () => {
  await manager?.dispose();
  await new Promise((r) => setTimeout(r, 50));
  brain.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function make(o: { project?: boolean } = {}): Promise<HiveManager> {
  manager = new HiveManager({
    brain,
    tokens: null,
    doors: null,
    userDataDir: join(root, 'userData'),
    libraryDir,
    engine: 'fake',
    engineOverride: demoEngine({ queenMs: 5, insectMs: 20, inspectorMs: 5 }),
    ...(o.project === false ? {} : { project: repo }),
    push: () => {},
    tickMs: 20,
    seed: 1,
    geminiDetect: async () => ({ status: 'missing' }),
  });
  await manager.init();
  return manager;
}

/** Three shelves: the project's ("site"), Global, and another project's. */
function seed(): { site: string; global: string; other: string } {
  clock += 1_000;
  const site = brain.write({ kind: 'decision', shelf: 'site', title: 'Use Astro', body: 'Static.' }, user).id;
  clock += 1_000;
  const global = brain.write({ kind: 'fact', shelf: 'global', title: 'Node 22', body: 'Node 22.' }, { type: 'agent', id: 'Librarian' }).id;
  clock += 1_000;
  const other = brain.write({ kind: 'update', shelf: 'elsewhere', title: 'Other', body: 'x' }, { type: 'agent', id: 'Scout' }).id;
  return { site, global, other };
}

describe('the timeline in the host', () => {
  it('scopes like the graph: the project plus Global, Global alone, every shelf; actors follow the scope', async () => {
    const m = await make();
    const { site, global, other } = seed();
    const ids = (scope: 'project' | 'global' | 'all') => BrainTimelineViewSchema.parse(m.brainTimeline({ scope })).entries.map((e) => e.recordId);
    expect(ids('project')).toEqual([global, site]);
    expect(ids('global')).toEqual([global]);
    expect(ids('all')).toEqual([other, global, site]);
    expect(m.brainTimeline({}).entries.map((e) => e.recordId)).toEqual([global, site]);
    expect(m.brainTimeline({ scope: 'project' }).actors).toEqual(['user', 'Librarian']);
    expect(m.brainTimeline({ scope: 'all' }).actors).toEqual(['user', 'Librarian', 'Scout']);
    expect(m.brainTimeline({ scope: 'global' }).actors).toEqual(['Librarian']);
  });

  it('with no project open, "project" means Global alone', async () => {
    const m = await make({ project: false });
    expect(m.project).toBeNull();
    const { global } = seed();
    expect(m.brainTimeline({ scope: 'project' }).entries.map((e) => e.recordId)).toEqual([global]);
  });

  it('passes the filters and the cursor through, and pages to the end', async () => {
    const m = await make();
    seed();
    for (let i = 0; i < 5; i++) brain.write({ kind: 'update', shelf: 'site', title: `Note ${i}`, body: `b${i}` }, user);
    expect(m.brainTimeline({ actor: 'agents' }).entries.map((e) => e.changedBy)).toEqual(['Librarian']);
    expect(m.brainTimeline({ kinds: ['decision'] }).entries.map((e) => e.title)).toEqual(['Use Astro']);
    expect(m.brainTimeline({ changes: ['update'] }).entries).toEqual([]);
    expect(m.brainTimeline({ query: 'node' }).entries.map((e) => e.title)).toEqual(['Node 22']);
    const seen: string[] = [];
    let page = m.brainTimeline({ limit: 3 });
    seen.push(...page.entries.map((e) => e.recordId));
    while (page.nextCursor) {
      page = m.brainTimeline({ limit: 3, before: page.nextCursor });
      seen.push(...page.entries.map((e) => e.recordId));
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('links an insect’s change to the goal of the card it held', async () => {
    const m = await make();
    const goal = brain.goals.create({ id: 'G-1', title: 'Pricing page', text: 'Build it.', shelf: 'site' });
    brain.taskboard.post({ id: 'C-01', goalId: goal.id, wave: 1, title: 'Pricing', brief: 'b', caste: 'coder', priority: 'normal', acceptance: ['ok'], dependsOn: [] });
    clock += 1_000;
    brain.taskboard.claim('C-01', { agentId: 'Ant-02', caste: 'coder', leaseMs: 600_000 });
    clock += 1_000;
    brain.write({ kind: 'update', shelf: 'site', title: 'Pricing uses Stripe', body: 'Checkout via Stripe.' }, ant);
    clock += 1_000;
    brain.taskboard.start('C-01', 'Ant-02');
    brain.taskboard.submit('C-01', 'Ant-02', 'done');
    clock += 1_000;
    brain.write({ kind: 'update', shelf: 'site', title: 'Later', body: 'After the card.' }, ant);
    const [later, during] = m.brainTimeline({ actor: 'Ant-02' }).entries;
    expect(during).toMatchObject({ title: 'Pricing uses Stripe', actorType: 'agent', goalId: 'G-1', goalTitle: 'Pricing page', what: 'Created' });
    expect(later).toMatchObject({ title: 'Later', goalId: null, goalTitle: null });
  });

  it('refuses a request outside the contract', async () => {
    const m = await make();
    expect(() => m.brainTimeline({ limit: 0 })).toThrow();
    expect(() => m.brainTimeline({ changes: ['delete' as never] })).toThrow();
  });
});

describe('the timeline over IPC', () => {
  it('validates the request in main, and the reply against BrainTimelineViewSchema', async () => {
    const m = await make();
    seed();
    const calls: Array<{ method: string; params: unknown }> = [];
    const host = {
      call: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        // What the Brain host's RPC switch does for this method.
        if (method === 'brainTimeline') return m.brainTimeline(params as Parameters<HiveManager['brainTimeline']>[0]);
        throw new Error(`unexpected ${method}`);
      },
    };
    registerHiveIpc({ host: () => host as never, window: () => null, assertTrustedSender: () => {} });
    const handler = electron.handlers.get(HIVE_IPC.brainTimeline)!;
    expect(handler).toBeTypeOf('function');

    const view = BrainTimelineViewSchema.parse(await handler({}, { scope: 'all', limit: 2 }));
    expect(view.entries).toHaveLength(2);
    expect(view.nextCursor).not.toBeNull();
    expect(view.actors).toEqual(['user', 'Librarian', 'Scout']);
    expect(calls).toEqual([{ method: 'brainTimeline', params: expect.objectContaining({ scope: 'all', limit: 2 }) }]);

    // No argument: the defaults (the project's scope, 50 per page).
    expect(BrainTimelineViewSchema.parse(await handler({}, undefined)).entries).toHaveLength(2);
    // Bad input never reaches the host.
    const before = calls.length;
    await expect(handler({}, { limit: 500 })).rejects.toThrow();
    await expect(handler({}, { actor: '' })).rejects.toThrow();
    await expect(handler({}, { before: { changedAt: 1, recordId: 'x' } })).rejects.toThrow();
    expect(calls).toHaveLength(before);
  });
});
