import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { demoEngine } from '@insectoids/harness';
import { HiveSnapshotSchema } from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HiveManager, e2eReadyEngines } from '../brain-host/hive-manager';
import { SAMPLE_GOAL_TEXT } from './practice-project';

/**
 * Onboarding in the host (Phase 2 C5): the e2e "two engines" setup shows a second engine as ready without it
 * ever running, and the sample goal plans one small card with the scripted engine.
 */
const libraryDir = fileURLToPath(new URL('../../../../library', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let brain: Brain;
let manager: HiveManager | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-setup-hm-'));
  repo = join(root, 'practice');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'greet.js'), 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n');
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

async function make(ready: Parameters<typeof e2eReadyEngines>[0] | null): Promise<HiveManager> {
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
    ...(ready ? { e2eReadyEngines: e2eReadyEngines(ready) } : {}),
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

describe('e2e ready engines (C5, "first run with two engines")', () => {
  it('parses the list: listed engines only, never the scripted one, no duplicates', () => {
    expect(e2eReadyEngines('claude, codex,claude,fake,nope,')).toEqual(['claude', 'codex']);
    expect(e2eReadyEngines('')).toEqual([]);
  });

  it('shows Claude Code as ready, but the scripted engine stays the default and runs everything', async () => {
    const m = await make('claude');
    await until('Claude shows as ready', () => m.engineCard('claude')?.state === 'ready');
    const snap = HiveSnapshotSchema.parse(m.snapshot());
    expect(snap.engines.filter((e) => e.state === 'ready' || e.state === 'fake').map((e) => e.id).sort()).toEqual(['claude', 'fake']);
    expect(snap.engine.state).toBe('fake');

    // A whole goal runs, and no run ever goes to Claude Code: it has no runner here.
    await m.command({ type: 'submitGoal', text: SAMPLE_GOAL_TEXT });
    const done = await until('the sample card is done', () => {
      const s = HiveSnapshotSchema.parse(m.snapshot());
      return s.cards.length === 1 && s.cards[0]!.status === 'done' ? s : null;
    });
    expect(done.agents.length).toBeGreaterThan(0);
    expect(done.agents.every((a) => a.engine === 'fake')).toBe(true);
  });

  it('switching projects does not leave the new hive paused (regression: "Switching project.")', async () => {
    const m = await make(null);
    const other = join(root, 'other');
    mkdirSync(other);
    git(other, 'init', '-q', '-b', 'main');
    git(other, 'config', 'user.name', 'Test');
    git(other, 'config', 'user.email', 't@example.com');
    writeFileSync(join(other, 'README.md'), '# Other\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'init');
    expect(await m.command({ type: 'setProject', path: other })).toEqual({ ok: true });
    let s = HiveSnapshotSchema.parse(m.snapshot());
    expect(s.hive).toMatchObject({ paused: false, pausedReason: null });
    expect(s.activity.some((a) => a.message === 'Switching project.')).toBe(false);
    // The new project's hive really works.
    await m.command({ type: 'submitGoal', text: SAMPLE_GOAL_TEXT });
    s = await until('the card is done', () => {
      const v = HiveSnapshotSchema.parse(m.snapshot());
      return v.cards.length === 1 && v.cards[0]!.status === 'done' ? v : null;
    });
    expect(s.project?.path).toBe(other);
    // A pause the user chose still carries over to the next project.
    await m.command({ type: 'pause', reason: 'Lunch.' });
    expect(await m.command({ type: 'setProject', path: repo })).toEqual({ ok: true });
    expect(HiveSnapshotSchema.parse(m.snapshot()).hive).toMatchObject({ paused: true, pausedReason: 'Lunch.' });
  });

  it('the sample goal plans one small card, so it needs no plan approval', async () => {
    const m = await make(null);
    expect(m.engineCard('claude')).toMatchObject({ state: 'missing' });
    await m.command({ type: 'submitGoal', text: SAMPLE_GOAL_TEXT });
    const s = await until('one card', () => {
      const v = HiveSnapshotSchema.parse(m.snapshot());
      return v.cards.length === 1 ? v : null;
    });
    expect(s.cards[0]).toMatchObject({ title: 'Add a farewell function', caste: 'coder' });
    expect(s.approvals.filter((a) => a.kind === 'plan')).toEqual([]);
  });
});
