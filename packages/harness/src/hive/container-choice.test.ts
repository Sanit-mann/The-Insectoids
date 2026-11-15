import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import type { CardContainer, ContainerSettings, GoalContainers } from '@insectoids/shared';
import { Workspace } from '@insectoids/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALL_CASTES } from './catalog';
import {
  CONTAINER_PAUSE,
  type HiveContainerSetup,
  cardContainerView,
  chooseContainer,
  containerWant,
} from './containers';
import { DEMO_CONTAINER_MARK, demoEngine } from './demo';
import { type EngineRequest, FakeEngine, type FakeReply } from './engine';
import { Hive, type HiveEvent, type HiveOptions } from './hive';
import { Library } from './prompts';

/** Phase 4 D2: who chooses containers (the setting, the user per goal, the Queen's mark, the Watchdog's move). */
const library = new Library(fileURLToPath(new URL('../../../../library', import.meta.url)));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const RUNTIME = { usable: true as const, runtime: 'docker' as const, command: '/usr/bin/docker', commandArgs: [], image: 'node:22-bookworm-slim', cpus: 2, memoryMb: 2048, pidsLimit: 256 };
const NOT_READY = { usable: false as const, reason: 'Docker is installed but not running. Start Docker Desktop.' };
const setupOf = (mode: ContainerSettings['mode'], usable: boolean): HiveContainerSetup => ({ mode, ...(usable ? RUNTIME : NOT_READY) });

const MARK = 'it installs packages';
const MOVE = 'The Watchdog moved it after it got stuck: It ran npm test 10 times.';

describe('the rule table (every setting x goal choice x Queen mark x Watchdog move, usable or not)', () => {
  /** The rule written out plainly, independent of the code: who applies (highest first) and what the card does. */
  function expected(mode: ContainerSettings['mode'], goal: GoalContainers, mark: string | null, move: string | null, usable: boolean) {
    let source: CardContainer['source'] | null = null;
    let wanted = false;
    if (mode === 'always') [source, wanted] = ['always', true];
    else if (goal === 'always') [source, wanted] = ['goal', true];
    else if (mode === 'auto' && move) [source, wanted] = ['watchdog', true];
    else if (mode === 'auto' && mark) [source, wanted] = ['queen', true];
    // Setting off: the Queen's mark is only shown; the Watchdog's move doesn't apply.
    else if (mode === 'off' && mark) [source, wanted] = ['queen', false];
    if (!source) return { view: null, run: 'computer' as const };
    const state = !wanted ? 'suggested' : usable ? 'container' : 'waiting';
    return { view: { source, state }, run: !wanted ? ('computer' as const) : usable ? ('container' as const) : ('refused' as const) };
  }

  const modes = ['off', 'auto', 'always'] as const;
  const goals = ['auto', 'always'] as const;
  const cases = modes.flatMap((mode) =>
    goals.flatMap((goal) => [null, MARK].flatMap((mark) => [null, MOVE].flatMap((move) => [true, false].map((usable) => ({ mode, goal, mark, move, usable }))))),
  );

  it.each(cases)('setting $mode, goal $goal, mark $mark, move $move, usable $usable', ({ mode, goal, mark, move, usable }) => {
    const setup = setupOf(mode, usable);
    const want = containerWant({ mode, goal, queenMark: mark, watchdogMove: move });
    const view = cardContainerView(want, setup);
    const exp = expected(mode, goal, mark, move, usable);
    expect(view ? { source: view.source, state: view.state } : null).toEqual(exp.view);
    // What the run gets: a container, a refusal (never the computer instead), or the computer as before.
    const choice = chooseContainer(setup, 'docs', 'insectoids-ant-01-1-abcdef', want?.wanted ?? false);
    const run = choice === null ? 'computer' : 'container' in choice ? 'container' : 'refused';
    expect(run).toBe(exp.run);
    if (choice && 'refused' in choice) expect(choice.refused).toBe(NOT_READY.reason);
    if (view?.state === 'waiting') expect(view.reason).toContain(NOT_READY.reason);
  });

  it('says why in plain words', () => {
    const view = (mode: ContainerSettings['mode'], goal: GoalContainers, mark: string | null, move: string | null) =>
      cardContainerView(containerWant({ mode, goal, queenMark: mark, watchdogMove: move }), setupOf(mode, true))?.reason;
    expect(view('always', 'auto', null, null)).toBe('Container mode is set to every card.');
    expect(view('off', 'always', null, null)).toBe('You chose containers for every card of this goal.');
    expect(view('auto', 'auto', MARK, MOVE)).toBe(MOVE);
    expect(view('auto', 'auto', MARK, null)).toBe('The Queen marked it: it installs packages.');
    expect(view('off', 'auto', MARK, null)).toBe('The Queen marked it: it installs packages. Containers are off, so it runs on this computer, guarded as usual.');
    expect(view('off', 'auto', null, MOVE)).toBeUndefined();
  });

  it('a bare "off" with no runtime details refuses a forced goal in words, never the computer', () => {
    const choice = chooseContainer({ mode: 'off' }, 'docs', 'x', true);
    expect(choice).toEqual({ refused: expect.stringMatching(/Docker or Podman isn’t set up/) });
  });
});

describe('the hive chooses per card', () => {
  let root: string;
  let repo: string;
  let brain: Brain;
  let ws: Workspace;
  let events: HiveEvent[];

  const json = (v: unknown): string => `\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;
  const cardOf = (req: EngineRequest): string => /# (?:Verify card|Card) (C-\d+)/.exec(req.task)?.[1] ?? '';
  const card = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Card ${id}`, brief: `Do ${id}.`, caste: 'coder', acceptance: [`${id} works`], ...extra });
  const planReply = (cards: Array<Record<string, unknown>>): FakeReply => ({ text: json({ summary: 'S', waves: [{ cards }] }) });
  const work = (req: EngineRequest): FakeReply => {
    if (req.role === 'inspector') return { text: 'VERDICT: PASS' };
    return { text: 'STATUS: DONE', effects: (cwd) => writeFileSync(join(cwd, `${cardOf(req)}.txt`), 'x') };
  };
  const makeHive = (engine: FakeEngine, containers: () => HiveContainerSetup, extra: Partial<HiveOptions> = {}) =>
    new Hive({
      brain, workspace: ws, engine, library, repoDir: repo, dataDir: join(root, 'data'), shelf: 'site', home: join(root, 'home'),
      models: { strongest: 'opus', standard: 'sonnet', light: 'haiku' }, insectCap: 2, castes: [...ALL_CASTES], leaseMs: 60_000,
      onEvent: (e) => events.push(e), containers, ...extra,
    });
  const boxOf = (engine: FakeEngine, role: string, id: string) => engine.calls.filter((c) => c.role === role && cardOf(c) === id).map((c) => c.guard.container ?? null);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'insectoids-box-choice-'));
    repo = join(root, 'project');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Test User');
    git(repo, 'config', 'user.email', 'user@example.com');
    writeFileSync(join(repo, 'README.md'), '# Site\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'initial');
    brain = openBrain(':memory:');
    ws = new Workspace({ repoDir: repo, worktreesRoot: join(root, 'worktrees') });
    events = [];
  });

  afterEach(async () => {
    await ws.dispose();
    brain.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('auto: the Queen-marked card (and its Inspector) runs in a container, the other card on the computer; the mark is kept in the plan', async () => {
    const engine = new FakeEngine((req) => (req.role === 'queen' ? planReply([card('C-01', { container: MARK }), card('C-02')]) : work(req)));
    const hive = makeHive(engine, () => setupOf('auto', true));
    const goal = await hive.submitGoal('Set up the linter');
    expect((brain.goals.get(goal.id)!.plan as { waves: Array<{ cards: Array<{ container?: string }> }> }).waves[0]!.cards.map((c) => c.container)).toEqual([MARK, undefined]);
    await hive.runUntilIdle();

    expect(boxOf(engine, 'coder', 'C-01')).toEqual([expect.objectContaining({ runtime: 'docker', network: 'none' })]);
    expect(boxOf(engine, 'inspector', 'C-01')).toEqual([expect.objectContaining({ network: 'none' })]);
    expect(boxOf(engine, 'coder', 'C-02')).toEqual([null]);
    expect(boxOf(engine, 'inspector', 'C-02')).toEqual([null]);
    expect(hive.cardContainer(`${goal.id}.C-01`)).toEqual({ source: 'queen', state: 'container', reason: 'The Queen marked it: it installs packages.' });
    expect(hive.cardContainer(`${goal.id}.C-02`)).toBeNull();
    // The lanes know which runs were in a container.
    const started = events.filter((e) => e.type === 'run-started' && e.run?.role === 'coder');
    expect(started.map((e) => [e.cardId, e.run!.container ?? false])).toEqual(expect.arrayContaining([[`${goal.id}.C-01`, true], [`${goal.id}.C-02`, false]]));
  });

  it('off: a Queen mark is only a suggestion; the card runs on the computer as today', async () => {
    const engine = new FakeEngine((req) => (req.role === 'queen' ? planReply([card('C-01', { container: MARK })]) : work(req)));
    const hive = makeHive(engine, () => setupOf('off', true));
    const goal = await hive.submitGoal('Set up the linter');
    await hive.runUntilIdle();
    expect(engine.calls.every((c) => !c.guard.container)).toBe(true);
    expect(hive.cardContainer(`${goal.id}.C-01`)).toMatchObject({ source: 'queen', state: 'suggested' });
  });

  it('auto but not usable: the marked card waits (never the computer); switching the setting off lets it run on the computer', async () => {
    let setup = setupOf('auto', false);
    const engine = new FakeEngine((req) => (req.role === 'queen' ? planReply([card('C-01', { container: MARK })]) : work(req)));
    const hive = makeHive(engine, () => setup);
    const goal = await hive.submitGoal('Set up the linter');
    await hive.runUntilIdle();
    expect(engine.calls.map((c) => c.role)).toEqual(['queen']);
    expect(hive.paused).toBe(true);
    expect(events.find((e) => e.type === 'paused')!.message).toMatch(new RegExp(`^${CONTAINER_PAUSE} Docker is installed but not running`));
    expect(hive.cardContainer(`${goal.id}.C-01`)).toMatchObject({ source: 'queen', state: 'waiting', reason: expect.stringContaining('Start Docker Desktop') });
    expect(hive.containersNeeded()).toBe(true);

    setup = setupOf('off', false);
    expect(hive.containersNeeded()).toBe(false);
    hive.resume();
    await hive.runUntilIdle();
    expect(boxOf(engine, 'coder', 'C-01')).toEqual([null]);
    expect(brain.taskboard.get(`${goal.id}.C-01`)!.status).toBe('done');
  });

  it('the user forces containers for a goal: every run of it uses one, even with the setting off', async () => {
    const engine = new FakeEngine((req) => (req.role === 'queen' ? planReply([card('C-01'), card('C-02')]) : work(req)));
    const hive = makeHive(engine, () => setupOf('off', true));
    const goal = await hive.submitGoal('Build it', { containers: 'always' });
    expect(brain.goals.get(goal.id)!.containers).toBe('always');
    await hive.runUntilIdle();
    const work_ = engine.calls.filter((c) => c.role !== 'queen');
    expect(work_).toHaveLength(4);
    expect(work_.every((c) => c.guard.container?.image === 'node:22-bookworm-slim')).toBe(true);
    expect(hive.cardContainer(`${goal.id}.C-01`)).toEqual({ source: 'goal', state: 'container', reason: 'You chose containers for every card of this goal.' });
  });

  it('a forced goal with the setting off and nothing set up is refused in words, never run on the computer', async () => {
    const engine = new FakeEngine((req) => (req.role === 'queen' ? planReply([card('C-01')]) : work(req)));
    const hive = makeHive(engine, () => ({ mode: 'off' }));
    await hive.submitGoal('Build it', { containers: 'always' });
    await hive.runUntilIdle();
    expect(engine.calls.map((c) => c.role)).toEqual(['queen']);
    expect(hive.paused).toBe(true);
    expect(brain.taskboard.list({ status: 'blocked' })).toHaveLength(1);
  });

  it('setGoalContainers applies to the next runs, and refuses finished or cancelled goals in plain words', async () => {
    const engine = new FakeEngine((req) => (req.role === 'queen' ? planReply([card('C-01')]) : work(req)));
    const hive = makeHive(engine, () => setupOf('auto', true));
    const goal = await hive.submitGoal('Build it');
    expect(brain.goals.get(goal.id)!.containers).toBe('auto');
    expect(hive.setGoalContainers(goal.id, 'always').containers).toBe('always');
    await hive.runUntilIdle();
    expect(boxOf(engine, 'coder', 'C-01')).toEqual([expect.objectContaining({ runtime: 'docker' })]);
    hive.setGoalContainers(goal.id, 'auto');
    expect(hive.cardContainer(`${goal.id}.C-01`)).toBeNull();

    await hive.cancelGoal(goal.id);
    expect(() => hive.setGoalContainers(goal.id, 'always')).toThrow(/"Build it" was cancelled, so it has no more runs to put in containers\./);
    const done = brain.goals.create({ title: 'Old work', text: 'x', shelf: 'site' });
    brain.goals.setStatus(done.id, 'running');
    brain.goals.setStatus(done.id, 'done');
    expect(() => hive.setGoalContainers(done.id, 'always')).toThrow(/"Old work" is finished/);
    expect(() => hive.setGoalContainers('G-missing', 'always')).toThrow(/No goal G-missing/);
  });
});

describe("the Watchdog's move (D2)", () => {
  let root: string;
  let repo: string;
  let brain: Brain;
  let ws: Workspace;
  let events: HiveEvent[];
  const FAST = { queenMs: 1, insectMs: 5, inspectorMs: 1 };
  const cardOf = (req: EngineRequest): string => /# (?:Verify card|Card) (C-\d+)/.exec(req.task)?.[1] ?? '';

  const makeHive = (engine: FakeEngine, containers: () => HiveContainerSetup, extra: Partial<HiveOptions> = {}) =>
    new Hive({
      brain, workspace: ws, engine, library, repoDir: repo, dataDir: join(root, 'data'), shelf: 'site', home: join(root, 'home'),
      models: { strongest: 'opus', standard: 'sonnet', light: 'haiku' }, insectCap: 2, castes: [...ALL_CASTES], leaseMs: 60_000,
      onEvent: (e) => events.push(e), containers, ...extra,
    });
  const coderBoxes = (engine: FakeEngine) => engine.calls.filter((c) => c.role === 'coder').map((c) => c.guard.container ?? null);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'insectoids-box-move-'));
    repo = join(root, 'project');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Test User');
    git(repo, 'config', 'user.email', 'user@example.com');
    writeFileSync(join(repo, 'README.md'), '# Site\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'initial');
    brain = openBrain(':memory:');
    ws = new Workspace({ repoDir: repo, worktreesRoot: join(root, 'worktrees') });
    events = [];
  });

  afterEach(async () => {
    await ws.dispose();
    brain.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('auto and usable: a card the Watchdog held runs its next attempt in a container once the Foreman sends it back; the move is kept on the card', async () => {
    const engine = demoEngine(FAST);
    const hive = makeHive(engine, () => setupOf('auto', true));
    const goal = await hive.submitGoal('Loop on purpose');
    await hive.runUntilIdle();

    // First attempt on the computer (nothing asked for a container), the retry in one; its Inspector too.
    expect(coderBoxes(engine)).toEqual([null, expect.objectContaining({ runtime: 'docker' })]);
    expect(engine.calls.find((c) => c.role === 'inspector')!.guard.container).toMatchObject({ network: 'none' });
    const id = `${goal.id}.C-01`;
    const card = brain.taskboard.get(id)!;
    expect(card.status).toBe('done');
    expect(card.containerMove).toMatch(/^The Watchdog moved it after it got stuck: .*npm test/);
    expect(brain.taskboard.events(id).some((e) => e.actor === 'Watchdog' && e.note === `container: ${card.containerMove}`)).toBe(true);
    expect(events.some((e) => e.type === 'watchdog' && e.message.startsWith('The Watchdog moved "Loop on purpose" into a container'))).toBe(true);

    // Kept in the Brain, not in this hive's memory: a fresh hive (as after a restart) still says so.
    const again = makeHive(demoEngine(FAST), () => setupOf('auto', true));
    expect(again.cardContainer(id)).toEqual({ source: 'watchdog', state: 'container', reason: card.containerMove });
    // Only while the setting is auto: off never runs it in a container because of the Watchdog.
    expect(makeHive(demoEngine(FAST), () => setupOf('off', true)).cardContainer(id)).toBeNull();
  });

  it('auto but not usable: nothing moves, and the card says why in plain words', async () => {
    const engine = demoEngine(FAST);
    const hive = makeHive(engine, () => setupOf('auto', false));
    const goal = await hive.submitGoal('Loop on purpose');
    await hive.runUntilIdle();
    const id = `${goal.id}.C-01`;
    expect(coderBoxes(engine)).toEqual([null, null]);
    expect(brain.taskboard.get(id)!.containerMove).toBeNull();
    const note = "The Watchdog would have moved it into a container, but containers aren't ready: Docker is installed but not running. Start Docker Desktop.";
    expect(brain.taskboard.events(id).some((e) => e.actor === 'Watchdog' && e.note === note)).toBe(true);
    expect(events.some((e) => e.type === 'watchdog' && e.message === `"Loop on purpose": ${note}`)).toBe(true);
    expect(hive.paused).toBe(false);
  });

  it('setting off: the Watchdog never moves a card and adds no note', async () => {
    const engine = demoEngine(FAST);
    const hive = makeHive(engine, () => setupOf('off', true));
    const goal = await hive.submitGoal('Loop on purpose');
    await hive.runUntilIdle();
    const id = `${goal.id}.C-01`;
    expect(coderBoxes(engine)).toEqual([null, null]);
    expect(brain.taskboard.get(id)!.containerMove).toBeNull();
    expect(brain.taskboard.events(id).some((e) => e.note?.includes('container'))).toBe(false);
  });

  it('a hard stop that sends the card straight back (no hold, no Foreman) moves it at once', async () => {
    let first = true;
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') return { text: `\`\`\`json\n${JSON.stringify({ summary: 'S', waves: [{ cards: [{ id: 'C-01', title: 'Big card', brief: 'Do it.', caste: 'coder', acceptance: ['works'] }] }] })}\n\`\`\`` };
      if (req.role === 'inspector') return { text: 'VERDICT: PASS' };
      if (first) {
        first = false;
        return { text: 'STATUS: DONE', tokens: 50_000 };
      }
      return { text: 'STATUS: DONE', effects: (cwd) => writeFileSync(join(cwd, `${cardOf(req)}.txt`), 'x') };
    });
    const hive = makeHive(engine, () => setupOf('auto', true), { watchdog: { hardRunTokens: 10_000 } });
    const goal = await hive.submitGoal('Big card');
    await hive.runUntilIdle();
    expect(brain.foreman.list()).toHaveLength(0);
    expect(coderBoxes(engine)).toEqual([null, expect.objectContaining({ runtime: 'docker' })]);
    expect(brain.taskboard.get(`${goal.id}.C-01`)!.containerMove).toMatch(/over the hard limit/);
  });

  it('the demo Queen marks the first card when the goal says "install"', async () => {
    const engine = demoEngine(FAST);
    const hive = makeHive(engine, () => setupOf('auto', true));
    const goal = await hive.submitGoal('Install the packages and add a farewell function');
    const plan = brain.goals.get(goal.id)!.plan as { waves: Array<{ cards: Array<{ id: string; container?: string }> }> };
    expect(plan.waves.flatMap((w) => w.cards).map((c) => [c.id, c.container ?? null])).toEqual([['C-01', DEMO_CONTAINER_MARK]]);
    expect(hive.cardContainer(`${goal.id}.C-01`)).toEqual({ source: 'queen', state: 'container', reason: 'The Queen marked it: it installs packages.' });
    const plain = await hive.submitGoal('Add a farewell function');
    expect((brain.goals.get(plain.id)!.plan as typeof plan).waves[0]!.cards[0]!.container).toBeUndefined();
    await hive.settle();
  });
});
