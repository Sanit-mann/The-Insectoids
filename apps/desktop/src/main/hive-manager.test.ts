import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { demoEngine } from '@insectoids/harness';
import { type HivePush, type HiveSnapshot, HiveSnapshotSchema } from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HiveManager, engineLines, shelfFor } from '../brain-host/hive-manager';
import { trayLabel } from './tray';

const libraryDir = fileURLToPath(new URL('../../../../library', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let brain: Brain;
let pushes: HivePush[];
let manager: HiveManager | null;

function makeRepo(name = 'my site'): string {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'README.md'), '# Site\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

type Options = ConstructorParameters<typeof HiveManager>[0];

/** realEngine: no scripted engine, so the manager checks for Claude Code (with the stubs given). */
function make(extra: Partial<Options> & { realEngine?: boolean } = {}): HiveManager {
  const { realEngine, ...rest } = extra;
  manager = new HiveManager({
    brain,
    tokens: null,
    doors: null,
    userDataDir: join(root, 'userData'),
    libraryDir,
    engine: 'fake',
    ...(realEngine ? {} : { engineOverride: demoEngine({ queenMs: 5, insectMs: 30, inspectorMs: 5 }) }),
    push: (p) => pushes.push(p),
    tickMs: 20,
    // Never the machine's real Gemini CLI: it may be installed and signed in, and would spend real quota.
    geminiDetect: async () => ({ status: 'missing' }),
    ...rest,
  });
  return manager;
}

const snap = (m: HiveManager): HiveSnapshot => HiveSnapshotSchema.parse(m.snapshot());

async function until<T>(what: string, read: () => T | undefined | null | false, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
const waiting = (m: HiveManager, kind: string) => until(`${kind} approval`, () => snap(m).approvals.find((a) => a.status === 'waiting' && a.kind === kind));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-hm-'));
  repo = makeRepo();
  brain = openBrain(':memory:');
  pushes = [];
  manager = null;
});

afterEach(async () => {
  await manager?.dispose();
  // Let in-flight git work settle before removing folders (Windows keeps handles briefly).
  await new Promise((r) => setTimeout(r, 50));
  brain.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('helpers', () => {
  it('turns a folder name into a Brain shelf', () => {
    expect(shelfFor('/x/My Site')).toBe('my-site');
    expect(shelfFor('C:\\work\\The Insectoids')).toBe('the-insectoids');
    expect(shelfFor('/x/---')).toBe('project-x');
    expect(shelfFor('/x/global')).toBe('project-global');
    expect(shelfFor(`/x/${'a'.repeat(80)}`)).toHaveLength(64);
  });

  it('shows engine output as short lines', () => {
    expect(engineLines({ kind: 'text', text: 'one\n\ntwo' })).toEqual(['one', 'two']);
    expect(engineLines({ kind: 'tool_use', id: '1', name: 'Write', input: { file_path: 'a.txt' } })).toEqual(['→ Write {"file_path":"a.txt"}']);
    expect(engineLines({ kind: 'tool_result', toolUseId: '1', isError: true, content: 'denied\nmore' })).toEqual(['✗ denied']);
    expect(engineLines({ kind: 'text', text: 'x'.repeat(400) })[0]).toHaveLength(300);
  });

  it('tray says working / idle / paused and needs you', () => {
    expect(trayLabel({ working: 0, approvals: 0, paused: false })).toBe('The Insectoids · hive idle');
    expect(trayLabel({ working: 2, approvals: 1, paused: false })).toBe('The Insectoids · hive working (2 agents) · needs you (1 approval)');
    expect(trayLabel({ working: 0, approvals: 3, paused: true })).toBe('The Insectoids · hive paused · needs you (3 approvals)');
  });
});

describe('projects', () => {
  it('starts with no project, then remembers the one you pick', async () => {
    const m = make();
    await m.init();
    expect(snap(m).project).toBeNull();
    expect(await m.command({ type: 'submitGoal', text: 'Do things' })).toEqual({ ok: false, error: 'Pick a project folder first.' });
    expect(await m.command({ type: 'setProject', path: repo })).toEqual({ ok: true });
    expect(snap(m).project).toMatchObject({ name: 'my site', shelf: 'my-site', branch: 'main' });
    expect(JSON.parse(readFileSync(join(root, 'userData', 'settings.json'), 'utf8'))).toEqual({ projectPath: expect.stringContaining('my site') });

    await m.dispose();
    const again = make();
    await again.init();
    expect(snap(again).project?.name).toBe('my site');
  });

  it('explains a missing folder, a non-git folder and a repo with no commits', async () => {
    const m = make();
    await m.init();
    const plain = join(root, 'plain');
    mkdirSync(plain);
    const empty = join(root, 'empty');
    mkdirSync(empty);
    git(empty, 'init', '-q');
    expect(await m.command({ type: 'setProject', path: join(root, 'nope') })).toMatchObject({ ok: false, error: expect.stringMatching(/does not exist/) });
    expect(await m.command({ type: 'setProject', path: plain })).toMatchObject({ ok: false, error: expect.stringMatching(/not a git repository/) });
    expect(await m.command({ type: 'setProject', path: empty })).toMatchObject({ ok: false, error: expect.stringMatching(/no commits/) });
  });
});

describe('engine state', () => {
  it('reports Claude Code missing / signed out / ready, and refuses goals until ready', async () => {
    let install: Awaited<ReturnType<NonNullable<Options['detect']>>> = { status: 'missing' };
    let loggedIn = false;
    const m = make({ engine: 'claude', realEngine: true, project: repo, detect: async () => install, auth: async () => ({ loggedIn }) });
    await m.init();
    await until('engine checked', () => snap(m).engine.state !== 'checking' && snap(m).engine);
    expect(snap(m).engine).toMatchObject({ state: 'missing', name: 'Claude Code' });
    expect(await m.command({ type: 'submitGoal', text: 'Hello there' })).toMatchObject({ ok: false, error: expect.stringMatching(/not ready/) });
    await m.dispose();

    install = { status: 'installed', command: 'claude', version: '2.1.322' };
    const signedOut = make({ engine: 'claude', realEngine: true, project: repo, detect: async () => install, auth: async () => ({ loggedIn }) });
    await signedOut.init();
    await until('engine checked', () => snap(signedOut).engine.state === 'signed-out');
    expect(snap(signedOut).engine.message).toMatch(/claude auth login/);
    await signedOut.dispose();

    loggedIn = true;
    const ready = make({ engine: 'claude', realEngine: true, project: repo, detect: async () => install, auth: async () => ({ loggedIn }) });
    await ready.init();
    await until('engine ready', () => snap(ready).engine.state === 'ready');
    expect(snap(ready).engine).toMatchObject({ version: '2.1.322' });
  });
  it('"check again" re-checks right away instead of waiting a minute', async () => {
    let loggedIn = false;
    const install = { status: 'installed' as const, command: 'claude', version: '2.1.322' };
    const m = make({ engine: 'claude', realEngine: true, project: repo, detect: async () => install, auth: async () => ({ loggedIn }) });
    await m.init();
    await until('signed out', () => snap(m).engine.state === 'signed-out');
    loggedIn = true; // the user signed in in a terminal
    expect(await m.command({ type: 'checkEngine' })).toEqual({ ok: true });
    expect(snap(m).engine.state).toBe('ready');
  });
});

describe('engine registry (Phase 2 A1)', () => {
  const install = { status: 'installed' as const, command: 'claude', version: '2.1.322' };

  it('lists every known engine; with the scripted engine, Claude Code is listed but never checked or run', async () => {
    const m = make({ project: repo });
    await m.init();
    await until('engines checked', () => snap(m).engines.every((e) => e.state !== 'checking'));
    const s = snap(m);
    expect(s.engines.map((e) => [e.id, e.state])).toEqual([
      ['fake', 'fake'],
      ['claude', 'missing'],
      ['gemini', 'missing'],
      ['codex', 'unsupported'],
      ['opencode', 'unsupported'],
    ]);
    expect(s.engines[1]!.message).toMatch(/Not checked/);
    // Gemini CLI is a real engine since A2; with the scripted engine it is listed but never checked or run.
    expect(s.engines.find((e) => e.id === 'gemini')).toMatchObject({ state: 'missing', availableIn: null, guard: 'read-only', reportsCost: false });
    expect(s.engines.find((e) => e.id === 'gemini')!.message).toMatch(/Not checked/);
    expect(s.engine).toMatchObject({ state: 'fake', name: 'Test engine' });
  });

  it('with Claude Code: the real adapter first, then the planned engines', async () => {
    const m = make({ engine: 'claude', realEngine: true, project: repo, detect: async () => install, auth: async () => ({ loggedIn: true }) });
    await m.init();
    await until('ready', () => snap(m).engine.state === 'ready');
    expect(snap(m).engines.map((e) => e.id)).toEqual(['claude', 'gemini', 'codex', 'opencode']);
    expect(snap(m).engines[0]).toMatchObject({ state: 'ready', guard: 'hook', reportsCost: true, models: { strongest: 'opus' } });
  });

  it('switching off and reordering persist across restarts', async () => {
    const m = make({ engine: 'claude', realEngine: true, project: repo, detect: async () => install, auth: async () => ({ loggedIn: true }) });
    await m.init();
    await until('ready', () => snap(m).engine.state === 'ready');
    expect(await m.command({ type: 'setEngineOrder', order: ['opencode', 'claude'] })).toEqual({ ok: true });
    expect(await m.command({ type: 'setEngineEnabled', engineId: 'gemini', enabled: false })).toEqual({ ok: true });
    await m.dispose();
    const again = make({ engine: 'claude', realEngine: true, project: repo, detect: async () => install, auth: async () => ({ loggedIn: true }) });
    await again.init();
    const s = snap(again);
    expect(s.engines.map((e) => e.id)).toEqual(['opencode', 'claude', 'gemini', 'codex']);
    expect(s.engines.find((e) => e.id === 'gemini')!.enabled).toBe(false);
  });

  it('with every engine switched off, goals are refused with a clear reason', async () => {
    const m = make({ engine: 'claude', realEngine: true, project: repo, detect: async () => install, auth: async () => ({ loggedIn: true }) });
    await m.init();
    await until('ready', () => snap(m).engine.state === 'ready');
    expect(await m.command({ type: 'setEngineEnabled', engineId: 'claude', enabled: false })).toEqual({ ok: true });
    // Gemini CLI is a real engine too (not installed in this test): it is still on, so it is the default view.
    expect(snap(m).engine).toMatchObject({ state: 'missing', name: 'Gemini CLI' });
    expect(await m.command({ type: 'setEngineEnabled', engineId: 'gemini', enabled: false })).toEqual({ ok: true });
    expect(snap(m).engine).toMatchObject({ state: 'missing', name: 'No AI engine' });
    expect(await m.command({ type: 'submitGoal', text: 'Hello there' })).toMatchObject({ ok: false, error: expect.stringMatching(/switched off/) });
  });

  it('refuses to switch off the only ready engine while a goal is running', async () => {
    const m = make({ project: repo });
    await m.init();
    await until('engine ready', () => snap(m).engine.state === 'fake');
    await m.command({ type: 'submitGoal', text: 'Say hello' });
    await waiting(m, 'plan');
    // Planning done, plan waiting: not running yet, so it may be switched off and on again.
    expect(await m.command({ type: 'setEngineEnabled', engineId: 'fake', enabled: false })).toEqual({ ok: true });
    expect(await m.command({ type: 'setEngineEnabled', engineId: 'fake', enabled: true })).toEqual({ ok: true });
    const plan = await waiting(m, 'plan');
    await m.command({ type: 'approve', approvalId: plan.id });
    await until('running', () => snap(m).goals[0]!.status === 'running');
    expect(await m.command({ type: 'setEngineEnabled', engineId: 'fake', enabled: false })).toMatchObject({ ok: false, error: expect.stringMatching(/only engine ready/) });
  });

  it('lanes say which engine ran them', async () => {
    const m = make({ project: repo });
    await m.init();
    await until('engine ready', () => snap(m).engine.state === 'fake');
    await m.command({ type: 'submitGoal', text: 'Say hello' });
    await until('a lane', () => snap(m).agents.length > 0);
    expect(snap(m).agents.every((a) => a.engine === 'fake')).toBe(true);
  });
});

describe('safety preset limits (Onboarding 08-D7)', () => {
  it('start with the given limits, show them in the snapshot, and change them live', async () => {
    const m = make({ project: repo, limits: { insectCap: 2, goalBudgetTokens: 1_000_000, approveEveryPlan: true } });
    await m.init();
    expect(snap(m).hive.insectCap).toBe(2);
    // Careful: even this plan waits for you (the demo plan is 2 waves anyway; the budget shows the preset).
    expect(await m.command({ type: 'submitGoal', text: 'Say hello please' })).toEqual({ ok: true });
    await waiting(m, 'plan');
    expect(snap(m).goals[0]?.budgetTokens).toBe(1_000_000);

    m.setLimits({ insectCap: 5, goalBudgetTokens: 4_000_000, approveEveryPlan: false });
    expect(snap(m).hive.insectCap).toBe(5);
    expect(m.limits).toEqual({ insectCap: 5, goalBudgetTokens: 4_000_000, approveEveryPlan: false });
    expect(() => m.setLimits({ insectCap: 0, goalBudgetTokens: 1, approveEveryPlan: false })).toThrow(/at least 1/);
  });

  it('defaults to Balanced', async () => {
    const m = make({ project: repo });
    await m.init();
    expect(snap(m).hive.insectCap).toBe(3);
  });
});

describe('a goal end to end through the manager', () => {
  it('plan approval, lanes, cards, merge, undo and redo, all in the snapshot', async () => {
    const m = make({ project: repo });
    await m.init();
    expect(await m.command({ type: 'submitGoal', text: 'Say hello' })).toEqual({ ok: true });
    // The goal appears at once, while the Queen plans.
    expect(snap(m).goals).toHaveLength(1);

    const plan = await waiting(m, 'plan');
    const s1 = snap(m);
    const goalId = s1.goals[0]!.id;
    expect(s1.goals[0]!.plan?.waves[0]!.cards[0]).toEqual({ id: `${goalId}.C-01`, title: 'Write hello.txt', caste: 'coder' });
    const queen = s1.agents.find((a) => a.role === 'queen')!;
    expect(queen).toMatchObject({ status: 'done', model: 'opus', effort: 'high', title: 'Plan: Say hello' });
    expect(queen.output).toContain('Plan: 2 waves, 3 cards.');

    expect(await m.command({ type: 'approve', approvalId: plan.id })).toEqual({ ok: true });
    expect(await m.command({ type: 'approve', approvalId: plan.id })).toMatchObject({ ok: false, error: 'This was already decided.' });

    const merge = await waiting(m, 'merge');
    const s2 = snap(m);
    expect(s2.cards.map((c) => c.status)).toEqual(['done', 'done', 'done']);
    expect(s2.cards.every((c) => !c.undone)).toBe(true);
    expect(s2.agents.filter((a) => a.role === 'insect').map((a) => a.caste).sort()).toEqual(['coder', 'coder', 'tester']);
    expect(s2.goals[0]!.spentTokens).toBeGreaterThan(0);
    expect(s2.activity.map((a) => a.type)).toEqual(expect.arrayContaining(['goal-planned', 'wave-posted', 'card-verified', 'approval-needed']));
    expect(s2.activity.some((a) => a.type === 'engine')).toBe(false);

    const changes = await m.changes({ goalId, cardId: `${goalId}.C-03` });
    expect(changes).toMatchObject({ files: [{ path: 'C-03.txt', status: 'added' }], truncated: false });

    expect(await m.command({ type: 'requestRedoMerge', goalId })).toMatchObject({ ok: false, error: expect.stringMatching(/no undone merge/) });
    expect(await m.command({ type: 'approve', approvalId: merge.id })).toEqual({ ok: true });
    expect(snap(m).goals[0]).toMatchObject({ status: 'done', merge: 'merged' });
    expect(existsSync(join(repo, 'C-01.txt'))).toBe(true);
    expect(await m.command({ type: 'undoCard', goalId, cardId: `${goalId}.C-01` })).toMatchObject({ ok: false, error: expect.stringMatching(/Undo the merge first/) });

    expect(await m.command({ type: 'requestUndoMerge', goalId })).toEqual({ ok: true });
    const undo = await waiting(m, 'merge');
    expect(undo.destructive).toBe(true);
    expect(await m.command({ type: 'approve', approvalId: undo.id })).toEqual({ ok: true });
    expect(snap(m).goals[0]!.merge).toBe('undone');
    expect(existsSync(join(repo, 'C-01.txt'))).toBe(false);

    // With the merge undone, a single card can be undone on the hive branch.
    expect(await m.command({ type: 'undoCard', goalId, cardId: `${goalId}.C-03` })).toEqual({ ok: true });
    await until('card marked undone', () => snap(m).cards.find((c) => c.id === `${goalId}.C-03`)?.undone);

    expect(await m.command({ type: 'requestRedoMerge', goalId })).toEqual({ ok: true });
    const redo = await waiting(m, 'merge');
    expect(await m.command({ type: 'approve', approvalId: redo.id })).toEqual({ ok: true });
    expect(snap(m).goals[0]!.merge).toBe('merged');
    expect(existsSync(join(repo, 'C-01.txt'))).toBe(true);

    await until('pushes', () => pushes.some((p) => p.type === 'agent-output') && pushes.some((p) => p.type === 'changed'));
    const out = pushes.find((p) => p.type === 'agent-output');
    expect(out).toMatchObject({ runId: expect.any(String), lines: expect.any(Array) });
  });

  it('cancelling a goal closes its approvals; undoing a goal marks its cards undone', async () => {
    const m = make({ project: repo });
    await m.init();
    await m.command({ type: 'submitGoal', text: 'Say hello' });
    await waiting(m, 'plan');
    const goalId = snap(m).goals[0]!.id;
    expect(await m.command({ type: 'cancelGoal', goalId })).toEqual({ ok: true });
    const s = snap(m);
    expect(s.goals[0]!.status).toBe('cancelled');
    expect(s.approvals.filter((a) => a.status === 'waiting')).toHaveLength(0);
    expect(await m.command({ type: 'cancelGoal', goalId: 'other' })).toMatchObject({ ok: false, error: 'No goal other in this project.' });

    await m.command({ type: 'submitGoal', text: 'Say hello again' });
    const plan = await waiting(m, 'plan');
    await m.command({ type: 'approve', approvalId: plan.id });
    const merge = await waiting(m, 'merge');
    await m.command({ type: 'deny', approvalId: merge.id });
    const g2 = snap(m).goals[0]!;
    expect(g2).toMatchObject({ status: 'done', merge: 'not-merged' });
    expect(await m.command({ type: 'undoGoal', goalId: g2.id })).toEqual({ ok: true });
    await until('cards undone', () => snap(m).cards.filter((c) => c.goalId === g2.id).every((c) => c.undone));
  });

  it('pause and resume reach the snapshot', async () => {
    const m = make({ project: repo });
    await m.init();
    expect(await m.command({ type: 'pause', reason: 'Lunch' })).toEqual({ ok: true });
    expect(snap(m).hive).toMatchObject({ paused: true, pausedReason: 'Lunch' });
    expect(await m.command({ type: 'resume' })).toEqual({ ok: true });
    expect(snap(m).hive).toMatchObject({ paused: false, pausedReason: null });
  });
});
