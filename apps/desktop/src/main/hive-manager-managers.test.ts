import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { demoEngine } from '@insectoids/harness';
import { HiveSnapshotSchema } from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HiveManager } from '../brain-host/hive-manager';

/** The managers' brain side in the host (Phase 2 C2): incidents, Foreman decisions, Scout, reviews, settings. */
const libraryDir = fileURLToPath(new URL('../../../../library', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let brain: Brain;
let manager: HiveManager | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-managers-hm-'));
  repo = join(root, 'site');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'README.md'), '# Site\n');
  writeFileSync(join(repo, 'src', 'hello.ts'), 'export function sayHello(name: string): string {\n  return `Hello ${name}`;\n}\n');
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

async function make(extra: Partial<ConstructorParameters<typeof HiveManager>[0]> = {}): Promise<HiveManager> {
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
    ...extra,
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

describe('the managers in the snapshot', () => {
  it('"Loop on purpose": incidents, a held card, the Foreman decision, then done', async () => {
    const m = await make();
    expect(await m.command({ type: 'submitGoal', text: 'Loop on purpose' })).toEqual({ ok: true });
    await until('the Foreman decision', () => snap(m).managers.foremanDecisions[0]);
    const s = await until('the card done', () => {
      const x = snap(m);
      return x.cards[0]?.status === 'done' ? x : null;
    });
    expect(s.incidents.map((i) => `${i.sensor}:${i.step}`).reverse()).toEqual(['loop:warn', 'loop:pause-card']);
    expect(s.managers.foremanDecisions[0]).toMatchObject({ action: 'retry-with-note', cardTitle: 'Loop on purpose' });
    expect(s.cards[0]!.heldReason).toBeNull();
    expect(s.activity.some((a) => a.type === 'watchdog')).toBe(true);
    expect(s.activity.some((a) => a.type === 'foreman')).toBe(true);
    expect(s.agents.some((a) => a.role === 'foreman')).toBe(true);
  });

  it('"Fail on purpose": the Foreman sends it to the Queen; the goal is stuck with its reason', async () => {
    const m = await make();
    await m.command({ type: 'submitGoal', text: 'Fail on purpose' });
    const s = await until('the goal stuck', () => {
      const x = snap(m);
      return x.goals[0]?.status === 'stuck' ? x : null;
    });
    expect(s.managers.foremanDecisions[0]).toMatchObject({ action: 'to-queen' });
    expect(s.activity.some((a) => a.type === 'goal-stuck' && a.message.startsWith('Foreman:'))).toBe(true);
  });
});

describe('the Scout and the settings', () => {
  it('surveys before the Queen when the code map is ready; not when switched off; the setting persists', async () => {
    const m = await make({ codeMap: {} });
    await m.codeMapIdle();
    await until('code map ready', () => snap(m).codeMap.state === 'ready');
    await m.command({ type: 'submitGoal', text: 'Survey the code first, then say hello' });
    const scout = await until('a scout lane', () => snap(m).agents.find((a) => a.role === 'scout'));
    const queen = await until('the queen lane', () => snap(m).agents.find((a) => a.role === 'queen'));
    expect(scout.startedAt).toBeLessThanOrEqual(queen.startedAt);

    expect(await m.command({ type: 'setManagers', scoutBeforePlanning: false, reviewEveryCards: 5 })).toEqual({ ok: true });
    expect(snap(m).managers).toMatchObject({ scoutBeforePlanning: false, reviewEveryCards: 5 });
    const saved = JSON.parse(readFileSync(join(root, 'userData', 'settings.json'), 'utf8')) as { managers: { scoutBeforePlanning: boolean; reviewEveryCards: number } };
    expect(saved.managers).toMatchObject({ scoutBeforePlanning: false, reviewEveryCards: 5 });

    await m.command({ type: 'submitGoal', text: 'Survey the code first, then say hello again' });
    await until('a second queen lane', () => snap(m).agents.filter((a) => a.role === 'queen').length >= 2);
    expect(snap(m).agents.filter((a) => a.role === 'scout')).toHaveLength(1);
  });

  it('settings come back after a restart', async () => {
    const m = await make();
    await m.command({ type: 'setManagers', scoutBeforePlanning: false, reviewEveryCards: 0 });
    await m.dispose();
    manager = null;
    const again = await make();
    expect(snap(again).managers).toMatchObject({ scoutBeforePlanning: false, reviewEveryCards: 0, cardsUntilReview: null });
  });
});

describe('the periodic review', () => {
  it('runs on demand with nothing finished: a Hive review record and a Queen line', async () => {
    const m = await make();
    expect(await m.command({ type: 'runReview' })).toEqual({ ok: true });
    const last = await until('the review', () => snap(m).managers.lastReview);
    expect(last.summary).toMatch(/^Hive review: 0 cards finished/);
    expect(last.recordId).not.toBeNull();
    expect(brain.get(last.recordId!)!.title).toMatch(/^Hive review/);
    expect(snap(m).activity.some((a) => a.type === 'foreman' && a.message.startsWith('Hive review:'))).toBe(true);
  });

  it('runs by itself after every N finished cards', async () => {
    const m = await make();
    await m.command({ type: 'setManagers', reviewEveryCards: 3 });
    await m.command({ type: 'submitGoal', text: 'Write the welcome docs' });
    const last = await until('the automatic review', () => snap(m).managers.lastReview, 30_000);
    expect(last.summary).toMatch(/^Hive review: 3 cards finished/);
    expect(snap(m).managers.cardsUntilReview).toBe(3);
  });
});
