import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { demoEngine } from '@insectoids/harness';
import { type HiveSnapshot, HiveSnapshotSchema } from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HiveManager } from '../brain-host/hive-manager';

/** Brain upkeep in the host (Phase 2 B2): the decay job, "Tidy now", restore, and the e2e seed. */
const libraryDir = fileURLToPath(new URL('../../../../library', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const ant = { type: 'agent', id: 'Ant-1' } as const;

let root: string;
let repo: string;
let brain: Brain;
let manager: HiveManager | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-tidy-hm-'));
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

function make(o: { shiftDays?: number; intervalMs?: number; seed?: boolean; insectMs?: number } = {}): HiveManager {
  manager = new HiveManager({
    brain,
    tokens: null,
    doors: null,
    userDataDir: join(root, 'userData'),
    libraryDir,
    engine: 'fake',
    engineOverride: demoEngine({ queenMs: 5, insectMs: o.insectMs ?? 20, inspectorMs: 5 }),
    project: repo,
    push: () => {},
    tickMs: 20,
    seed: 1,
    geminiDetect: async () => ({ status: 'missing' }),
    tidy: { ...(o.shiftDays ? { clockShiftDays: o.shiftDays } : {}), ...(o.intervalMs ? { intervalMs: o.intervalMs } : {}) },
    ...(o.seed ? { seedBrainForE2E: true } : {}),
  });
  return manager;
}

const snap = (m: HiveManager): HiveSnapshot => HiveSnapshotSchema.parse(m.snapshot());
const tidyLines = (m: HiveManager) => snap(m).activity.filter((a) => a.type === 'brain-tidy').map((a) => a.message);

async function until<T>(what: string, read: () => T | undefined | null | false, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('Brain upkeep in the host (B2)', () => {
  it('fades old agent notes at start, says so, and the user can bring one back', async () => {
    const note = brain.write({ kind: 'update', shelf: 'site', title: 'Scratch', body: 'An old note nobody read.' }, ant).id;
    const mine = brain.write({ kind: 'update', shelf: 'site', title: 'Mine', body: 'The user wrote this.' }, { type: 'user' }).id;
    const m = make({ shiftDays: 90 });
    await m.init();
    expect(brain.get(note)).toMatchObject({ archived: true, archivedReason: 'faded: unused for 90 days' });
    expect(brain.get(mine)!.archived).toBe(false);
    expect(tidyLines(m)).toEqual([expect.stringMatching(/^Faded into the archive: "Scratch" \(unused for 90 days\)/)]);
    expect(await m.command({ type: 'restoreRecord', id: note })).toEqual({ ok: true });
    expect(brain.get(note)).toMatchObject({ archived: false, archivedReason: null });
  });

  it('"Tidy now" with nothing old says the Brain is tidy', async () => {
    brain.write({ kind: 'update', shelf: 'site', title: 'Fresh', body: 'Written today.' }, ant);
    const m = make();
    await m.init();
    expect(await m.command({ type: 'tidyBrain' })).toEqual({ ok: true });
    expect(tidyLines(m)).toEqual(['The Brain is tidy: nothing to fade.']);
  });

  it('the scheduled job waits while the hive is busy', async () => {
    const m = make({ shiftDays: 90, intervalMs: 25, insectMs: 1500 });
    await m.init();
    expect(await m.command({ type: 'submitGoal', text: 'Say hello' })).toEqual({ ok: true });
    const plan = await until('plan approval', () => snap(m).approvals.find((a) => a.status === 'waiting'));
    await m.command({ type: 'approve', approvalId: plan.id });
    await until('an insect working', () => snap(m).hive.working > 0);
    const note = brain.write({ kind: 'update', shelf: 'site', title: 'Scratch', body: 'An old note.' }, ant).id;
    await new Promise((r) => setTimeout(r, 200));
    expect(brain.get(note)!.archived).toBe(false);
  });

  it('e2e seed: near-duplicates fold into one, and the superseded fact is history', async () => {
    const m = make({ seed: true });
    await m.init();
    const checkout = brain.search('checkout stripe', { shelf: 'site' });
    expect(checkout).toHaveLength(1);
    expect(brain.links(checkout[0]!.id)).toContainEqual(expect.objectContaining({ rel: 'merged_into', direction: 'in' }));
    expect(brain.search('hosting provider', { shelf: 'site' }).map((h) => h.status)).toEqual(['current']);
    expect(brain.search('hosting provider', { shelf: 'site', includeHistory: true }).map((h) => h.status).sort()).toEqual(['current', 'superseded']);
    expect(m.brainRecent({ includeHistory: true }).some((h) => h.status === 'superseded')).toBe(true);
  });
});
