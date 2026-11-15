import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { CONTAINER_PAUSE, demoEngine } from '@insectoids/harness';
import { type ContainerStatus, ContainerStatusSchema, DEFAULT_CONTAINER_IMAGE, DEFAULT_CONTAINER_SETTINGS, type HiveSnapshot, HiveSnapshotSchema } from '@insectoids/shared';
import type { RuntimeFound } from '@insectoids/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContainerRuntimeDeps } from '../brain-host/containers';
import { HiveManager } from '../brain-host/hive-manager';

/**
 * Container mode in the host (Phase 4 D1): detection, words for every state, the image download, settings that
 * persist, and card runs that get a container (or wait, never falling back to the computer). The runtime layer is
 * a fake here: nothing starts Docker or Podman.
 */
const libraryDir = fileURLToPath(new URL('../../../../library', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let brain: Brain;
let managers: HiveManager[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-box-hm-'));
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
  managers = [];
});

afterEach(async () => {
  for (const m of managers) await m.dispose();
  brain.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

async function until<T>(what: string, read: () => T | undefined | null | false, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A runtime the test controls: what detection finds, which images are here, and a pull that reports lines. */
function fakeRuntime(found: RuntimeFound | null) {
  const state = { found, images: new Set<string>(), leftovers: 0, pulls: [] as string[], pullFails: false, removedRuns: [] as string[] };
  const deps: ContainerRuntimeDeps = {
    detect: async () => state.found,
    imagePresent: async (_rt, image) => state.images.has(image),
    pullImage: (_rt, image, onLine) => {
      state.pulls.push(image);
      const done = (async () => {
        for (const line of ['Pulling from library/node', 'Downloading  40MB/80MB', 'Status: Downloaded newer image']) {
          await new Promise((r) => setTimeout(r, 20));
          onLine(line);
        }
        if (state.pullFails) return { ok: false, error: 'network unreachable' };
        state.images.add(image);
        return { ok: true };
      })();
      return { done, stop: () => {} };
    },
    removeLeftovers: async () => {
      state.leftovers++;
      return 2;
    },
    removeRun: async (_rt, run) => {
      state.removedRuns.push(run);
      return 1;
    },
  };
  return { state, deps };
}

const DOCKER: RuntimeFound = { kind: 'docker', command: '/usr/bin/docker', commandArgs: [], version: '27.3.1', running: true };

function create(deps: ContainerRuntimeDeps, o: { project?: boolean; engine?: ReturnType<typeof demoEngine> } = {}): HiveManager {
  const m = new HiveManager({
    brain,
    tokens: null,
    doors: null,
    userDataDir: join(root, 'userData'),
    libraryDir,
    engine: 'fake',
    engineOverride: o.engine ?? demoEngine({ queenMs: 5, insectMs: 20, inspectorMs: 5 }),
    ...(o.project ? { project: repo } : {}),
    push: () => {},
    tickMs: 20,
    seed: 1,
    geminiDetect: async () => ({ status: 'missing' }),
    containers: { deps },
  });
  managers.push(m);
  return m;
}

const status = (m: HiveManager): ContainerStatus => ContainerStatusSchema.parse(m.containersStatus());
const snap = (m: HiveManager): HiveSnapshot => HiveSnapshotSchema.parse(m.snapshot());
const checked = (m: HiveManager) => until('the container check', () => status(m).runtime.state !== 'checking' && status(m));

describe('container mode status in plain words (Phase 4 D1)', () => {
  it('no runtime: names Docker Desktop and Podman Desktop with their pages, and says the app never installs one', async () => {
    const { deps } = fakeRuntime(null);
    const m = create(deps);
    await m.init();
    const s = await checked(m);
    expect(s).toMatchObject({ runtime: { state: 'missing', kind: null, version: null }, imagePresent: null, usable: false, settings: DEFAULT_CONTAINER_SETTINGS });
    expect(s.message).toMatch(/Docker Desktop \(https:\/\/www\.docker\.com\/products\/docker-desktop\/\)/);
    expect(s.message).toMatch(/Podman Desktop \(https:\/\/podman-desktop\.io\/\)/);
    expect(s.message).toMatch(/the app never installs one/);
    expect(s.message).toMatch(/Container mode is off, so card commands run on this computer/);
  });

  it('not running: says to start Docker Desktop (or Podman Desktop for Podman)', async () => {
    const { state, deps } = fakeRuntime({ ...DOCKER, running: false });
    const m = create(deps);
    await m.init();
    expect((await checked(m)).message).toMatch(/^Docker is installed but not running\. Start Docker Desktop, then press Check again/);
    state.found = { ...DOCKER, kind: 'podman', running: false, version: '5.2.0' };
    expect((await m.containersRecheck()).message).toMatch(/^Podman is installed but not running\. Start Podman Desktop/);
    // Leftovers are only cleared once a runtime is actually running.
    expect(state.leftovers).toBe(0);
  });

  it('image missing: offers the download (about 80 MB); the download shows progress, then the image is here', async () => {
    const { state, deps } = fakeRuntime(DOCKER);
    const m = create(deps);
    await m.init();
    let s = await checked(m);
    expect(s).toMatchObject({ runtime: { state: 'ready', kind: 'docker', version: '27.3.1' }, imagePresent: false, usable: false });
    expect(s.message).toBe('Docker 27.3.1 is ready, but the image isn\'t on this computer yet. Download the image (about 80 MB) on the Containers settings.');
    expect(state.leftovers).toBe(1);

    expect(m.containersPull()).toEqual({ ok: true });
    expect(m.containersPull()).toEqual({ ok: false, error: 'The image is already downloading.' });
    expect(status(m).pulling).toEqual({ image: DEFAULT_CONTAINER_IMAGE, line: 'Starting the download…' });
    await until('a progress line', () => status(m).pulling?.line.startsWith('Downloading'));
    s = await until('the image', () => status(m).imagePresent === true && status(m));
    expect(s.pulling).toBeNull();
    expect(state.pulls).toEqual([DEFAULT_CONTAINER_IMAGE]);
    expect(s.message).toMatch(/^Docker 27\.3\.1 is ready and the image is on this computer\. Container mode is off/);

    // Check again doesn't clear leftovers a second time in the same run of the app.
    await m.containersRecheck();
    expect(state.leftovers).toBe(1);
  });

  it('a failed download says so and offers the download again', async () => {
    const { state, deps } = fakeRuntime(DOCKER);
    state.pullFails = true;
    const m = create(deps);
    await m.init();
    await checked(m);
    m.containersPull();
    const s = await until('the failed download', () => !status(m).pulling && status(m).message.includes('didn\'t finish') && status(m));
    expect(s.imagePresent).toBe(false);
    expect(s.message).toMatch(/The last download didn't finish: network unreachable/);
  });

  it('settings persist with the hive settings; a bad image is refused in words', async () => {
    const { state, deps } = fakeRuntime(DOCKER);
    state.images.add(DEFAULT_CONTAINER_IMAGE);
    const m = create(deps);
    await m.init();
    await checked(m);
    expect(await m.containersSave({ ...DEFAULT_CONTAINER_SETTINGS, image: 'node:22; rm -rf /' })).toEqual({ ok: false, error: expect.stringMatching(/isn’t an image name the app can use/) });
    expect(await m.containersSave({ mode: 'always', image: DEFAULT_CONTAINER_IMAGE, cpus: 1.5, memoryMb: 1024, pidsLimit: 128 })).toEqual({ ok: true });
    expect(status(m)).toMatchObject({ usable: true, settings: { mode: 'always', cpus: 1.5 } });
    expect(status(m).message).toMatch(/^Container mode is on: every card's commands run in a Docker container/);
    const file = JSON.parse(readFileSync(join(root, 'userData', 'settings.json'), 'utf8')) as { containers: unknown };
    expect(file.containers).toEqual({ mode: 'always', image: DEFAULT_CONTAINER_IMAGE, cpus: 1.5, memoryMb: 1024, pidsLimit: 128 });

    await m.dispose();
    const again = create(deps);
    expect(status(again).settings).toEqual({ mode: 'always', image: DEFAULT_CONTAINER_IMAGE, cpus: 1.5, memoryMb: 1024, pidsLimit: 128 });
  });

  it('a malformed setting in the file falls back to off', async () => {
    mkdirSync(join(root, 'userData'), { recursive: true });
    writeFileSync(join(root, 'userData', 'settings.json'), JSON.stringify({ containers: { mode: 'always', image: 'BAD IMAGE', cpus: 2, memoryMb: 2048, pidsLimit: 256 } }));
    const m = create(fakeRuntime(null).deps);
    expect(status(m).settings).toEqual(DEFAULT_CONTAINER_SETTINGS);
  });
});

describe('card runs in container mode, through the host', () => {
  it('ready: a goal runs with a container on every insect and Inspector run, and none on the Queen', async () => {
    const { state, deps } = fakeRuntime(DOCKER);
    state.images.add(DEFAULT_CONTAINER_IMAGE);
    const engine = demoEngine({ queenMs: 5, insectMs: 20, inspectorMs: 5 });
    const m = create(deps, { project: true, engine });
    await m.init();
    await checked(m);
    await m.containersSave({ ...DEFAULT_CONTAINER_SETTINGS, mode: 'always' });
    expect(await m.command({ type: 'submitGoal', text: 'Add a farewell function to the site' })).toEqual({ ok: true });
    await until('the merge approval', () => snap(m).approvals.find((a) => a.status === 'waiting' && a.kind === 'merge'), 30_000);

    const queen = engine.calls.filter((c) => c.role === 'queen');
    const work = engine.calls.filter((c) => c.role !== 'queen');
    expect(queen.every((c) => !c.guard.container)).toBe(true);
    expect(work.length).toBeGreaterThan(0);
    for (const c of work) {
      expect(c.guard.container).toMatchObject({ runtime: 'docker', command: '/usr/bin/docker', image: DEFAULT_CONTAINER_IMAGE, cpus: 2, memoryMb: 2048, pidsLimit: 256 });
      expect(c.guard.container!.name).toMatch(/^insectoids-[a-z0-9-]+$/);
    }
    expect(new Set(work.map((c) => c.guard.container!.name)).size).toBe(work.length);
    // Every run's containers are removed when that run ends, however it ended (here: each one finished).
    await until('every run cleaned up', () => state.removedRuns.length >= work.length || null);
    expect([...state.removedRuns].sort()).toEqual(work.map((c) => c.guard.container!.name).sort());
  }, 40_000);

  it('not usable: cards wait with the reason and the hive pauses; once Docker runs, it carries on by itself in containers', async () => {
    const { state, deps } = fakeRuntime({ ...DOCKER, running: false });
    state.images.add(DEFAULT_CONTAINER_IMAGE);
    const engine = demoEngine({ queenMs: 5, insectMs: 20, inspectorMs: 5 });
    const m = create(deps, { project: true, engine });
    await m.init();
    await checked(m);
    await m.containersSave({ ...DEFAULT_CONTAINER_SETTINGS, mode: 'always' });
    expect(await m.command({ type: 'submitGoal', text: 'Add a farewell function to the site' })).toEqual({ ok: true });

    const paused = await until('the container pause', () => snap(m).hive.pausedReason?.startsWith(CONTAINER_PAUSE) && snap(m).hive.pausedReason);
    expect(paused).toMatch(/^Container mode: Docker is installed but not running\. Start Docker Desktop/);
    expect(paused).toMatch(/they never run on your computer instead/);
    expect(engine.calls.every((c) => c.role === 'queen')).toBe(true);
    expect(snap(m).cards.some((c) => c.status === 'blocked')).toBe(true);

    state.found = DOCKER;
    await m.containersRecheck();
    await until('the merge approval', () => snap(m).approvals.find((a) => a.status === 'waiting' && a.kind === 'merge'), 30_000);
    expect(snap(m).hive.paused).toBe(false);
    const work = engine.calls.filter((c) => c.role !== 'queen');
    expect(work.length).toBeGreaterThan(0);
    expect(work.every((c) => c.guard.container?.image === DEFAULT_CONTAINER_IMAGE)).toBe(true);
  }, 40_000);
});

describe('who chooses containers, through the host (Phase 4 D2)', () => {
  const ready = async (mode: 'off' | 'auto' | 'always', running = true) => {
    const { state, deps } = fakeRuntime({ ...DOCKER, running });
    state.images.add(DEFAULT_CONTAINER_IMAGE);
    const engine = demoEngine({ queenMs: 5, insectMs: 20, inspectorMs: 5 });
    const m = create(deps, { project: true, engine });
    await m.init();
    await checked(m);
    expect(await m.containersSave({ ...DEFAULT_CONTAINER_SETTINGS, mode })).toEqual({ ok: true });
    return { m, engine, state };
  };
  const merge = (m: HiveManager) => until('the merge approval', () => snap(m).approvals.find((a) => a.status === 'waiting' && a.kind === 'merge'), 30_000);

  it('auto: the status says so; a goal with "install" gets a Queen-marked card that runs in a container, shown on the card and its lane', async () => {
    const { m, engine } = await ready('auto');
    const s = status(m);
    expect(s.usable).toBe(true);
    expect(s.message).toMatch(/^Containers when needed: cards the Queen marks as risky, cards the Watchdog moves after they got stuck, and goals you choose/);
    expect(await m.command({ type: 'submitGoal', text: 'Install the packages and add a farewell function' })).toEqual({ ok: true });
    await merge(m);

    const view = snap(m);
    expect(view.goals[0]!.containers).toBe('auto');
    expect(view.cards[0]!.container).toEqual({ source: 'queen', state: 'container', reason: 'The Queen marked it: it installs packages.' });
    expect(engine.calls.filter((c) => c.role !== 'queen').every((c) => c.guard.container)).toBe(true);
    const lanes = view.agents;
    expect(lanes.find((l) => l.role === 'queen')!.container).toBe(false);
    expect(lanes.filter((l) => l.role === 'insect' || l.role === 'inspector').every((l) => l.container)).toBe(true);
  }, 40_000);

  it('auto: a goal without a mark runs on the computer, and its card has nothing to say', async () => {
    const { m, engine } = await ready('auto');
    await m.command({ type: 'submitGoal', text: 'Add a farewell function to the site' });
    await merge(m);
    expect(snap(m).cards[0]!.container).toBeNull();
    expect(engine.calls.every((c) => !c.guard.container)).toBe(true);
    expect(snap(m).agents.every((l) => !l.container)).toBe(true);
  }, 40_000);

  it('off: the Queen mark shows as a suggestion and the card runs on the computer', async () => {
    const { m, engine } = await ready('off');
    await m.command({ type: 'submitGoal', text: 'Install the packages and add a farewell function' });
    await merge(m);
    expect(snap(m).cards[0]!.container).toMatchObject({ source: 'queen', state: 'suggested', reason: expect.stringMatching(/Containers are off, so it runs on this computer/) });
    expect(engine.calls.every((c) => !c.guard.container)).toBe(true);
  }, 40_000);

  it('submitGoal with containers "always" runs the goal in containers even with the setting off', async () => {
    const { m, engine } = await ready('off');
    await m.command({ type: 'submitGoal', text: 'Add a farewell function to the site', containers: 'always' });
    await merge(m);
    const view = snap(m);
    expect(view.goals[0]!.containers).toBe('always');
    expect(view.cards[0]!.container).toEqual({ source: 'goal', state: 'container', reason: 'You chose containers for every card of this goal.' });
    expect(engine.calls.filter((c) => c.role !== 'queen').every((c) => c.guard.container?.image === DEFAULT_CONTAINER_IMAGE)).toBe(true);
  }, 40_000);

  it('setGoalContainers: a forced goal waits while Docker is off; letting it follow the setting again carries on by itself on the computer', async () => {
    const { m, engine } = await ready('off', false);
    await m.command({ type: 'submitGoal', text: 'Add a farewell function to the site', containers: 'always' });
    await until('the container pause', () => snap(m).hive.pausedReason?.startsWith(CONTAINER_PAUSE));
    const goalId = snap(m).goals[0]!.id;
    expect(snap(m).cards[0]!.container).toMatchObject({ source: 'goal', state: 'waiting', reason: expect.stringMatching(/Docker is installed but not running/) });
    expect(engine.calls.every((c) => c.role === 'queen')).toBe(true);

    expect(await m.command({ type: 'setGoalContainers', goalId, containers: 'auto' })).toEqual({ ok: true });
    expect(snap(m).goals[0]!.containers).toBe('auto');
    expect(snap(m).activity.some((a) => a.message.includes('follows the container setting again'))).toBe(true);
    await merge(m);
    expect(snap(m).hive.paused).toBe(false);
    expect(engine.calls.filter((c) => c.role !== 'queen').every((c) => !c.guard.container)).toBe(true);

    expect(await m.command({ type: 'cancelGoal', goalId })).toEqual({ ok: true });
    expect(await m.command({ type: 'setGoalContainers', goalId, containers: 'always' })).toEqual({
      ok: false,
      error: '"Add a farewell function to the site" was cancelled, so it has no more runs to put in containers.',
    });
    expect(await m.command({ type: 'setGoalContainers', goalId: 'G-nope', containers: 'always' })).toEqual({ ok: false, error: 'No goal G-nope in this project.' });
  }, 40_000);

  it('while Docker downloads or stays off, a hive paused for a card that still needs a container stays paused', async () => {
    const { m, state } = await ready('auto', false);
    await m.command({ type: 'submitGoal', text: 'Install the packages and add a farewell function' });
    await until('the container pause', () => snap(m).hive.pausedReason?.startsWith(CONTAINER_PAUSE));
    await m.containersRecheck();
    expect(snap(m).hive.paused).toBe(true);
    expect(snap(m).cards[0]!.container?.state).toBe('waiting');
    state.found = DOCKER;
    await m.containersRecheck();
    await merge(m);
    expect(snap(m).cards[0]!.container?.state).toBe('container');
  }, 40_000);
});
