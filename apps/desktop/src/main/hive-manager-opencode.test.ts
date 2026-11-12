import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { type LlmAccess, type ReadyProvider, demoEngine } from '@insectoids/harness';
import { type HiveSnapshot, HiveSnapshotSchema } from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HiveManager } from '../brain-host/hive-manager';

/**
 * Phase 2 A4: OpenCode as a hive engine, end to end through the manager with a stand-in OpenCode
 * (packages/harness/src/opencode/fake-opencode.mjs) that checks the run's safety rules itself.
 * No AI calls, no install, no keys.
 */
const libraryDir = fileURLToPath(new URL('../../../../library', import.meta.url));
const FAKE = fileURLToPath(new URL('../../../../packages/harness/src/opencode/fake-opencode.mjs', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let brain: Brain;
let manager: HiveManager | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-oc-'));
  repo = join(root, 'my site');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'README.md'), '# Site\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  brain = openBrain(':memory:');
});

afterEach(async () => {
  await manager?.dispose();
  manager = null;
  brain.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

const snap = (m: HiveManager): HiveSnapshot => HiveSnapshotSchema.parse(m.snapshot());
async function until<T>(what: string, read: () => T | undefined | null | false, timeoutMs = 25_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const tiers = { strongest: 'anthropic/claude-opus', standard: 'meta-llama/llama-3.3-70b', light: 'qwen/qwen3-8b' };

function setup(providers: ReadyProvider[]) {
  const issued: string[] = [];
  const revoked: string[] = [];
  const llm: LlmAccess = {
    issue: async (runId) => {
      issued.push(runId);
      return { baseUrl: 'http://127.0.0.1:43210/llm/openrouter', pass: `pass_${issued.length}` };
    },
    usage: async () => ({ model: 'meta-llama/llama-3.3-70b-instruct', input: 900, output: 100, cacheRead: 0, calls: 1 }),
    revoke: async (pass) => {
      revoked.push(pass);
    },
  };
  // The stand-in never starts the MCP servers; the hive tools only need to exist for the full guard mode.
  const tools = join(root, 'hive-tools-mcp.mjs');
  writeFileSync(tools, '');
  const doors = {
    runtime: { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } },
    guardHook: join(root, 'guard-hook.mjs'),
    brainMcp: join(root, 'brain-mcp.mjs'),
    brainCli: join(root, 'brain.mjs'),
    hiveTools: tools,
    servicesMcp: join(root, 'services-mcp.mjs'),
  };
  manager = new HiveManager({
    brain,
    tokens: null,
    doors,
    userDataDir: join(root, 'userData'),
    libraryDir,
    engine: 'fake',
    engineOverride: demoEngine({ queenMs: 5, insectMs: 30, inspectorMs: 5 }),
    project: repo,
    push: () => {},
    tickMs: 20,
    geminiDetect: async () => ({ status: 'missing' }),
    opencodeDetect: async () => ({ status: 'installed', command: process.execPath, version: '2.2.1', args: [FAKE] }),
    opencodeSystemConfig: () => null,
    providers: async () => providers,
    llm,
  });
  return { m: manager, issued, revoked };
}

describe('OpenCode as a hive engine (Phase 2 A4)', () => {
  it('is ready only with a provider; then a goal runs on it, each run with its own broker pass', async () => {
    const { m, issued, revoked } = setup([{ id: 'openrouter', label: 'OpenRouter', local: false, models: tiers }]);
    await m.init();
    await until('engines checked', () => snap(m).engines.every((e) => e.state !== 'checking'));
    expect(snap(m).engines.find((e) => e.id === 'opencode')).toMatchObject({
      state: 'ready',
      guard: 'policy-and-tools',
      reportsCost: true,
      models: tiers,
      message: 'OpenCode 2.2.1 is ready with OpenRouter.',
    });

    // Make OpenCode the hive's engine: switch the scripted one off.
    expect(await m.command({ type: 'setEngineEnabled', engineId: 'fake', enabled: false })).toEqual({ ok: true });
    expect(snap(m).engine).toMatchObject({ state: 'ready', name: 'OpenCode' });

    expect(await m.command({ type: 'submitGoal', text: 'Say hello in hello.txt' })).toEqual({ ok: true });
    await until('the merge approval', () => snap(m).approvals.find((a) => a.status === 'waiting' && a.kind === 'merge'), 40_000);

    const s = snap(m);
    expect(s.cards.map((c) => [c.title, c.status])).toEqual([['Write hello.txt', 'done']]);
    const runs = s.agents.filter((a) => a.engine === 'opencode');
    expect(runs.map((a) => a.role).sort()).toEqual(['insect', 'inspector', 'queen']);
    // The broker saw the model that answered; that's what the lanes show.
    expect(runs.every((a) => a.model === 'meta-llama/llama-3.3-70b-instruct')).toBe(true);
    expect(issued).toHaveLength(3);
    expect(revoked.sort()).toEqual(['pass_1', 'pass_2', 'pass_3']);
  }, 60_000);

  it('without a ready provider it says what to do, and never asks for a pass', async () => {
    const { m, issued } = setup([]);
    await m.init();
    await until('engines checked', () => snap(m).engines.every((e) => e.state !== 'checking'));
    expect(snap(m).engines.find((e) => e.id === 'opencode')).toMatchObject({ state: 'signed-out', message: expect.stringMatching(/API providers tab/) });
    expect(issued).toEqual([]);
  });
});
