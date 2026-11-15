import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { Workspace } from '@insectoids/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_CONTAINER_NOTE, ClaudeEngine, type EngineRequest, FakeEngine, type FakeReply } from './engine';
import { CONTAINER_PAUSE, type HiveContainerSetup, chooseContainer, containerRunName } from './containers';
import { Hive, type HiveEvent } from './hive';
import { Library } from './prompts';

const library = new Library(fileURLToPath(new URL('../../../../library', import.meta.url)));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const READY: HiveContainerSetup = {
  mode: 'always',
  usable: true,
  runtime: 'docker',
  command: '/usr/bin/docker',
  commandArgs: [],
  image: 'node:22-bookworm-slim',
  cpus: 2,
  memoryMb: 2048,
  pidsLimit: 256,
};
const NOT_RUNNING: HiveContainerSetup = { mode: 'always', usable: false, reason: 'Docker is installed but not running. Start Docker Desktop.' };

describe('container names and choices', () => {
  it('names each run uniquely with only lowercase letters, digits and dashes', () => {
    const names = new Set(Array.from({ length: 50 }, (_, i) => containerRunName('Inspector:site-1.C-01', i)));
    expect(names.size).toBe(50);
    for (const n of names) {
      // The runtime layer's rule for a name (it adds "-<n>" per command).
      expect(n).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
      expect(`${n}-999`.length).toBeLessThanOrEqual(63);
    }
    // Two calls with the same counter still differ (a restart starts the counter again).
    expect(containerRunName('Ant-01', 1)).not.toBe(containerRunName('Ant-01', 1));
  });

  it('turns the caste network into the container network: web is open, docs-only and none get none', () => {
    const net = (n: 'none' | 'docs' | 'web') => {
      const c = chooseContainer(READY, n, 'x');
      return c && 'container' in c ? c.container.network : null;
    };
    expect([net('web'), net('docs'), net('none')]).toEqual(['open', 'none', 'none']);
    expect(chooseContainer({ mode: 'off' }, 'web', 'x')).toBeNull();
    expect(chooseContainer(undefined, 'web', 'x')).toBeNull();
    expect(chooseContainer(NOT_RUNNING, 'docs', 'x')).toEqual({ refused: NOT_RUNNING.reason });
  });
});

describe('the hive in container mode (Phase 4 D1)', () => {
  let root: string;
  let repo: string;
  let brain: Brain;
  let ws: Workspace;
  let events: HiveEvent[];

  const planReply = (cards: Array<{ id: string; caste: string }>): FakeReply => ({
    text: `\`\`\`json\n${JSON.stringify({ summary: 'p', waves: [{ cards: cards.map((c) => ({ id: c.id, title: `Card ${c.id}`, brief: `Do ${c.id}`, caste: c.caste, acceptance: ['works'] })) }] })}\n\`\`\``,
  });
  const cardOf = (req: EngineRequest): string => /# (?:Verify card|Card) (C-\d+)/.exec(req.task)?.[1] ?? '';
  const work = (req: EngineRequest): FakeReply => {
    if (req.role === 'inspector') return { text: 'VERDICT: PASS' };
    return { text: 'STATUS: DONE', effects: (cwd) => writeFileSync(join(cwd, `${cardOf(req)}.txt`), 'x') };
  };
  const makeHive = (engine: FakeEngine, containers: () => HiveContainerSetup): Hive =>
    new Hive({
      brain, workspace: ws, engine, library, repoDir: repo, dataDir: join(root, 'data'), shelf: 'site', home: join(root, 'home'),
      models: { strongest: 'opus', standard: 'sonnet', light: 'haiku' }, insectCap: 3, castes: ['coder', 'tester', 'researcher'],
      leaseMs: 60_000, onEvent: (e) => events.push(e), containers,
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'insectoids-hive-box-'));
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

  it('gives insect and Inspector runs a container with their caste network and a unique name; the Queen none', async () => {
    const engine = new FakeEngine((req) =>
      req.role === 'queen' ? planReply([{ id: 'C-01', caste: 'coder' }, { id: 'C-02', caste: 'researcher' }, { id: 'C-03', caste: 'tester' }]) : work(req),
    );
    const hive = makeHive(engine, () => READY);
    await hive.submitGoal('Build and research');
    await hive.runUntilIdle();

    const byRun = engine.calls.map((c) => ({ who: `${c.role}:${cardOf(c)}`, box: c.guard.container ?? null }));
    expect(byRun.find((r) => r.who === 'queen:')!.box).toBeNull();
    const net = (who: string) => byRun.find((r) => r.who === who)?.box?.network;
    expect(net('coder:C-01')).toBe('none'); // docs-only caste: no network in a container
    expect(net('tester:C-03')).toBe('none');
    expect(net('researcher:C-02')).toBe('open'); // web caste: the open web
    for (const id of ['C-01', 'C-02', 'C-03']) expect(net(`inspector:${id}`)).toBe('none');
    const boxes = byRun.filter((r) => r.box).map((r) => r.box!);
    expect(boxes).toHaveLength(6);
    expect(new Set(boxes.map((b) => b.name)).size).toBe(6);
    expect(boxes[0]).toMatchObject({ runtime: 'docker', command: '/usr/bin/docker', image: 'node:22-bookworm-slim', cpus: 2, memoryMb: 2048, pidsLimit: 256 });
  });

  it('runs as before (no container) when container mode is off', async () => {
    const engine = new FakeEngine((req) => (req.role === 'queen' ? planReply([{ id: 'C-01', caste: 'coder' }]) : work(req)));
    const hive = makeHive(engine, () => ({ mode: 'off' }));
    await hive.submitGoal('g');
    await hive.runUntilIdle();
    expect(engine.calls.length).toBe(3);
    expect(engine.calls.every((c) => c.guard.container === undefined)).toBe(true);
  });

  it('refuses card runs when containers are not usable: the card waits blocked, the hive pauses, nothing runs on the computer', async () => {
    let setup: HiveContainerSetup = NOT_RUNNING;
    const engine = new FakeEngine((req) => (req.role === 'queen' ? planReply([{ id: 'C-01', caste: 'coder' }, { id: 'C-02', caste: 'tester' }]) : work(req)));
    const hive = makeHive(engine, () => setup);
    await hive.submitGoal('g');
    await hive.runUntilIdle();

    expect(engine.calls.map((c) => c.role)).toEqual(['queen']);
    expect(hive.paused).toBe(true);
    const paused = events.filter((e) => e.type === 'paused');
    expect(paused).toHaveLength(1);
    expect(paused[0]!.message).toMatch(new RegExp(`^${CONTAINER_PAUSE} Docker is installed but not running\\. Start Docker Desktop\\. Cards that run commands wait; they never run on your computer instead\\.`));
    // Dispatching stopped at the first refusal: one card waits with the reason, the other is still open.
    const blocked = brain.taskboard.list({ status: 'blocked' });
    expect(blocked).toHaveLength(1);
    expect(brain.taskboard.events(blocked[0]!.id).at(-1)?.note).toBe(`${CONTAINER_PAUSE} ${NOT_RUNNING.reason}`);
    expect(blocked[0]!.attempts).toBe(0);
    expect(events.some((e) => e.type === 'card-blocked' && e.message.startsWith(CONTAINER_PAUSE))).toBe(true);

    // Docker started: resume puts the waiting card back on the board, and the cards run in containers.
    setup = READY;
    hive.resume();
    expect(brain.taskboard.list({ status: 'blocked' })).toHaveLength(0);
    await hive.runUntilIdle();
    const insects = engine.calls.filter((c) => c.role === 'coder' || c.role === 'tester');
    expect(insects.map(cardOf).sort()).toEqual(['C-01', 'C-02']);
    expect(insects.every((c) => c.guard.container?.network === 'none')).toBe(true);
    expect(brain.taskboard.list({ status: 'done' })).toHaveLength(2);
  });

  it('refuses the Inspector too: the card stays in review until containers are ready', async () => {
    let setup: HiveContainerSetup = READY;
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') return planReply([{ id: 'C-01', caste: 'coder' }]);
      // Docker stops while the insect works.
      if (req.role === 'coder') setup = NOT_RUNNING;
      return work(req);
    });
    const hive = makeHive(engine, () => setup);
    await hive.submitGoal('g');
    await hive.runUntilIdle();
    expect(engine.calls.map((c) => c.role)).toEqual(['queen', 'coder']);
    expect(hive.paused).toBe(true);
    expect(brain.taskboard.list({ status: 'review' })).toHaveLength(1);

    setup = READY;
    hive.resume();
    await hive.runUntilIdle();
    expect(engine.calls.map((c) => c.role)).toEqual(['queen', 'coder', 'inspector']);
    expect(engine.calls[2]!.guard.container?.network).toBe('none');
    expect(brain.taskboard.list({ status: 'done' })).toHaveLength(1);
  });

  it('after the user switches container mode off, resume runs the waiting card on the computer as before', async () => {
    let setup: HiveContainerSetup = NOT_RUNNING;
    const engine = new FakeEngine((req) => (req.role === 'queen' ? planReply([{ id: 'C-01', caste: 'coder' }]) : work(req)));
    const hive = makeHive(engine, () => setup);
    await hive.submitGoal('g');
    await hive.runUntilIdle();
    setup = { mode: 'off' };
    hive.resume();
    await hive.runUntilIdle();
    const coder = engine.calls.find((c) => c.role === 'coder')!;
    expect(coder.guard.container).toBeUndefined();
    expect(brain.taskboard.list({ status: 'done' })).toHaveLength(1);
  });
});

describe('ClaudeEngine: the hive tools server joins only in container mode', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'insectoids-claude-box-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  /** A stand-in `claude` that reports its MCP config (or none) and its system prompt. */
  async function runProbe(container: boolean, hiveTools: boolean) {
    const probe = join(tmp, 'probe.mjs');
    writeFileSync(probe, `
      import { readFileSync } from 'node:fs';
      const a = process.argv.slice(2);
      const at = a.indexOf('--mcp-config');
      const sys = a[a.indexOf('--append-system-prompt-file') + 1];
      process.stdin.resume();
      process.stdin.on('end', () => {
        const report = { mcp: at >= 0 ? JSON.parse(readFileSync(a[at + 1], 'utf8')) : null, system: sys ? readFileSync(sys, 'utf8') : null, guard: JSON.parse(process.env.INSECTOIDS_GUARD) };
        process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(report), session_id: 's', num_turns: 1, duration_ms: 1, total_cost_usd: 0, usage: {} }) + '\\n');
      });`);
    const script = join(tmp, 'hive-tools-mcp.mjs');
    writeFileSync(script, '// stand-in bundle');
    const runtime = { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
    const engine = new ClaudeEngine({
      claude: process.execPath,
      claudeArgs: [probe],
      hook: { command: process.execPath, args: [] },
      promptDir: join(tmp, 'prompts'),
      ...(hiveTools ? { hiveTools: { script, runtime } } : {}),
    });
    const box = { runtime: 'docker' as const, command: 'docker', commandArgs: [], image: 'node:22', network: 'none' as const, cpus: 1, memoryMb: 512, pidsLimit: 64, name: 'insectoids-ant-01-1-abcdef' };
    const r = await engine.run({
      role: 'coder', agentId: 'Ant-01', cwd: tmp, system: 'sys', task: 'go',
      route: { model: 'sonnet', effort: 'low', maxTurns: 2, maxBudgetUsd: 1, timeoutMs: 20_000 } as EngineRequest['route'],
      guard: { workspace: tmp, home: tmp, noGo: [], network: 'docs', ...(container ? { container: box } : {}) },
    }).done;
    return { ...(JSON.parse(r.text) as { mcp: { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> } | null; system: string | null; guard: Record<string, unknown> }), script, box };
  }

  it('adds the hive server with the run guard (container included) in container mode, and tells Claude to use run_shell', async () => {
    const r = await runProbe(true, true);
    const hive = r.mcp!.mcpServers['hive']!;
    expect(hive.command).toBe(process.execPath);
    expect(hive.args).toEqual([r.script]);
    expect(hive.env['ELECTRON_RUN_AS_NODE']).toBe('1');
    const guard = JSON.parse(hive.env['INSECTOIDS_GUARD']!) as { container: unknown; workspace: string; network: string };
    expect(guard.container).toEqual(r.box);
    expect(guard).toMatchObject({ workspace: tmp, network: 'docs' });
    // The hook gets the same container (it blocks Claude's own Bash there).
    expect(r.guard['container']).toEqual(r.box);
    expect(r.system).toContain(CLAUDE_CONTAINER_NOTE);
  });

  it('adds no hive server and no note outside container mode', async () => {
    const r = await runProbe(false, true);
    expect(r.mcp).toBeNull();
    expect(r.system).toBe('sys');
  });

  it('without the hive tools bundle, container mode adds nothing (Claude then has no shell at all)', async () => {
    const r = await runProbe(true, false);
    expect(r.mcp).toBeNull();
    expect(r.system).toBe('sys');
    expect(readFileSync(join(tmp, 'prompts', 'Ant-01-1.md'), 'utf8')).toBe('sys');
  });
});
