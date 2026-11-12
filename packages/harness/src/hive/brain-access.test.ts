import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { Workspace } from '@insectoids/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// The real Brain service (relative import: the harness itself only knows the BrainAccess interface).
import { BrainClient, BrainServiceError, type BrainService, startBrainService } from '../../../brain-service/src/index';
import {
  BRAIN_ENV_ENDPOINT,
  BRAIN_ENV_TOKEN,
  type BrainAccess,
  type BrainGrant,
  type RunBrain,
  brainMcpConfig,
  brainRunEnv,
  brainWriteAccess,
  prependPath,
} from './brain-access';
import { ClaudeEngine, type Engine, type EngineRequest, type EngineRun, FakeEngine, type FakeReply } from './engine';
import { Hive } from './hive';
import { Library } from './prompts';

const library = new Library(fileURLToPath(new URL('../../../../library', import.meta.url)));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const doors = { runtime: { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }, mcpScript: '/doors/brain-mcp.mjs', cliShimDir: '/doors/bin' };
const sample: RunBrain = { endpoint: '\\\\.\\pipe\\x', token: 'tok', write: true, doors };

describe('brain access helpers', () => {
  it('insects write; the Queen and the Inspector only read', () => {
    expect(brainWriteAccess('coder')).toBe(true);
    expect(brainWriteAccess('tester')).toBe(true);
    expect(brainWriteAccess('queen')).toBe(false);
    expect(brainWriteAccess('inspector')).toBe(false);
  });

  it('the MCP config starts only the Brain door, with the run token', () => {
    expect(brainMcpConfig(sample)).toEqual({
      mcpServers: {
        brain: {
          command: process.execPath,
          args: ['/doors/brain-mcp.mjs'],
          env: { ELECTRON_RUN_AS_NODE: '1', [BRAIN_ENV_ENDPOINT]: '\\\\.\\pipe\\x', [BRAIN_ENV_TOKEN]: 'tok' },
        },
      },
    });
  });

  it('puts the shim folder first on PATH, keeping the platform spelling of the key', () => {
    expect(prependPath('/doors/bin', { Path: 'C:\\Windows' })).toEqual({ Path: `/doors/bin${delimiter}C:\\Windows` });
    expect(prependPath('/doors/bin', { PATH: '/usr/bin' })).toEqual({ PATH: `/doors/bin${delimiter}/usr/bin` });
    expect(prependPath('/doors/bin', {})).toEqual({ PATH: '/doors/bin' });
    expect(brainRunEnv(sample, { PATH: '/usr/bin' })).toEqual({ [BRAIN_ENV_ENDPOINT]: sample.endpoint, [BRAIN_ENV_TOKEN]: 'tok', PATH: `/doors/bin${delimiter}/usr/bin` });
  });
});

describe('ClaudeEngine with Brain access', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'insectoids-brainrun-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('passes the MCP config file and the Brain env to the CLI, and deletes the config afterwards', async () => {
    // A stand-in CLI that reports what it was given.
    const probe = join(tmp, 'probe.mjs');
    writeFileSync(probe, `
      import { readFileSync } from 'node:fs';
      const a = process.argv.slice(2);
      const cfg = a[a.indexOf('--mcp-config') + 1];
      process.stdin.resume();
      process.stdin.on('end', () => {
        const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH');
        const report = { strict: a.includes('--strict-mcp-config'), cfgPath: cfg, mcp: JSON.parse(readFileSync(cfg, 'utf8')),
          endpoint: process.env.${BRAIN_ENV_ENDPOINT}, token: process.env.${BRAIN_ENV_TOKEN}, path: process.env[pathKey] };
        const o = (x) => process.stdout.write(JSON.stringify(x) + '\\n');
        o({ type: 'system', subtype: 'init', session_id: 's', model: 'm' });
        o({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(report), session_id: 's', num_turns: 1, duration_ms: 1, total_cost_usd: 0, usage: {} });
      });`);
    const engine = new ClaudeEngine({ claude: process.execPath, claudeArgs: [probe], hook: { command: process.execPath, args: [] }, promptDir: join(tmp, 'prompts') });
    const req: EngineRequest = {
      role: 'coder', agentId: 'Ant-01', cwd: tmp, system: 'sys', task: 'go',
      route: { model: 'sonnet', effort: 'low', maxTurns: 2, maxBudgetUsd: 1, timeoutMs: 20_000 } as EngineRequest['route'],
      guard: { workspace: tmp, home: tmp, noGo: [], network: 'none' },
      brain: { ...sample, doors: { ...doors, cliShimDir: join(tmp, 'bin') } },
    };
    const handle = engine.run(req);
    const result = await handle.done;
    expect(result.ok).toBe(true);
    const report = JSON.parse(result.text) as { strict: boolean; cfgPath: string; mcp: unknown; endpoint: string; token: string; path: string };
    expect(report.strict).toBe(true);
    expect(report.mcp).toEqual(brainMcpConfig(req.brain!));
    expect(report.endpoint).toBe(sample.endpoint);
    expect(report.token).toBe('tok');
    expect(report.path.startsWith(`${join(tmp, 'bin')}${delimiter}`)).toBe(true);
    expect(existsSync(report.cfgPath)).toBe(false);
  });

  it('adds nothing when the run has no Brain access', async () => {
    const probe = join(tmp, 'probe.mjs');
    writeFileSync(probe, `
      const a = process.argv.slice(2);
      process.stdin.resume();
      process.stdin.on('end', () => {
        const o = (x) => process.stdout.write(JSON.stringify(x) + '\\n');
        const report = { mcp: a.includes('--mcp-config'), token: process.env.${BRAIN_ENV_TOKEN} ?? null };
        o({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(report), session_id: 's', num_turns: 1, duration_ms: 1, total_cost_usd: 0, usage: {} });
      });`);
    const engine = new ClaudeEngine({ claude: process.execPath, claudeArgs: [probe], hook: { command: process.execPath, args: [] }, promptDir: join(tmp, 'prompts') });
    const result = await engine.run({
      role: 'coder', agentId: 'Ant-01', cwd: tmp, system: 'sys', task: 'go',
      route: { model: 'sonnet', effort: 'low', maxTurns: 2, maxBudgetUsd: 1, timeoutMs: 20_000 } as EngineRequest['route'],
      guard: { workspace: tmp, home: tmp, noGo: [], network: 'none' },
    }).done;
    expect(JSON.parse(result.text)).toEqual({ mcp: false, token: process.env[BRAIN_ENV_TOKEN] ?? null });
  });
});

describe('hive runs get scoped Brain tokens (Memory 01-D5)', () => {
  let root: string;
  let repo: string;
  let brain: Brain;
  let ws: Workspace;
  let service: BrainService;
  const grants: BrainGrant[] = [];
  const revoked: string[] = [];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'insectoids-hivebrain-'));
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
    service = await startBrainService({ brain });
    grants.length = 0;
    revoked.length = 0;
  });

  afterEach(async () => {
    await service.close();
    await ws.dispose();
    brain.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const access = (): BrainAccess => ({
    endpoint: service.endpoint,
    doors,
    grant: (g) => {
      grants.push(g);
      const token = service.issueAgentToken(g);
      return { token, revoke: () => (revoked.push(token), service.revokeToken(token)) };
    },
  });

  /** Like an agent with the MCP door: talks to the Brain during its run, then replies like the FakeEngine script says. */
  class BrainUsingEngine implements Engine {
    readonly fake: FakeEngine;
    readonly seen: Array<{ role: string; identity: unknown; wrote: string; tokenAfter?: string }> = [];
    constructor(script: (req: EngineRequest) => FakeReply) {
      this.fake = new FakeEngine(script);
    }
    run(req: EngineRequest): EngineRun {
      const done = (async () => {
        const b = req.brain!;
        const client = await BrainClient.connect({ endpoint: b.endpoint, token: b.token });
        const found = await client.search({ query: 'contact form' });
        const wrote = await client
          .write({ kind: 'fact', title: `${req.agentId} learned`, body: `The ${req.role} saw ${found.length} related record(s).` })
          .then(
            (w) => (w.created ? 'ok' : 'dup'),
            (e: unknown) => (e instanceof BrainServiceError ? e.code : 'error'),
          );
        this.seen.push({ role: req.role, identity: client.identity, wrote });
        client.close();
        return this.fake.run(req).done;
      })();
      return { done, stop: () => {} };
    }
  }

  it('each run gets its own token with the right access, uses the Brain through it, and the token dies after', async () => {
    const engine = new BrainUsingEngine((req) => {
      if (req.role === 'queen') return { text: `\`\`\`json\n${JSON.stringify({ summary: 's', waves: [{ cards: [{ id: 'C-01', title: 'Form', brief: 'Build it', caste: 'coder', acceptance: ['works'] }] }] })}\n\`\`\`` };
      if (req.role === 'inspector') return { text: 'VERDICT: PASS' };
      return { text: 'STATUS: DONE', effects: (cwd) => writeFileSync(join(cwd, 'form.js'), 'x') };
    });
    const hive = new Hive({
      brain, workspace: ws, engine, library, repoDir: repo, dataDir: join(root, 'data'), shelf: 'site', home: join(root, 'home'),
      models: { strongest: 'opus', standard: 'sonnet', light: 'haiku' }, insectCap: 2, castes: ['coder', 'tester'], leaseMs: 60_000,
      brainAccess: access(),
    });
    await hive.submitGoal('Add a contact form');
    await hive.runUntilIdle();

    expect(grants.map((g) => `${g.agentId}:${g.shelf}:${g.write}`)).toEqual([
      'Queen:site:false',
      expect.stringMatching(/^Ant-\d+:site:true$/),
      'Inspector:site:false',
    ]);
    expect(engine.seen.map((s) => `${s.role}:${s.wrote}`)).toEqual(['queen:forbidden', 'coder:ok', 'inspector:forbidden']);
    expect(engine.seen[1]!.identity).toMatchObject({ type: 'agent', shelf: 'site', write: true });
    // The insect's note landed as its own, unconfirmed fact.
    const fact = brain.search('learned', { shelf: 'site' })[0]!;
    expect(brain.get(fact.id)).toMatchObject({ kind: 'fact', trust: 'unconfirmed' });

    // Every token was revoked when its run ended.
    expect(revoked).toHaveLength(3);
    for (const token of revoked) {
      await expect(BrainClient.connect({ endpoint: service.endpoint, token })).rejects.toMatchObject({ code: 'unauthorized' });
    }
    // Briefs mention the Brain, with the right access.
    const calls = engine.fake.calls;
    expect(calls.every((c) => c.system.includes('## The Brain'))).toBe(true);
    expect(calls.find((c) => c.role === 'coder')!.system).toContain('Record what the next agent should know');
    expect(calls.find((c) => c.role === 'inspector')!.system).toContain('read-only');
    expect(calls.find((c) => c.role === 'coder')!.brain).toMatchObject({ endpoint: service.endpoint, write: true, doors });
  });

  it('revokes the token even when the run fails', async () => {
    const engine: Engine = { run: () => ({ done: Promise.reject(new Error('engine crashed')), stop: () => {} }) };
    const hive = new Hive({
      brain, workspace: ws, engine, library, repoDir: repo, dataDir: join(root, 'data'), shelf: 'site', home: join(root, 'home'),
      models: { strongest: 'opus', standard: 'sonnet', light: 'haiku' }, insectCap: 2, castes: ['coder'], leaseMs: 60_000,
      brainAccess: access(),
    });
    await expect(hive.submitGoal('Anything')).rejects.toThrow(/engine crashed/);
    expect(grants).toHaveLength(1);
    expect(revoked).toHaveLength(1);
  });

  it('without brainAccess nothing changes: no token, no Brain rules, no Brain field', async () => {
    const engine = new FakeEngine((req) => (req.role === 'queen' ? { text: 'no plan' } : { text: 'STATUS: DONE' }));
    const hive = new Hive({
      brain, workspace: ws, engine, library, repoDir: repo, dataDir: join(root, 'data'), shelf: 'site', home: join(root, 'home'),
      models: { strongest: 'opus', standard: 'sonnet', light: 'haiku' }, insectCap: 2, castes: ['coder'], leaseMs: 60_000,
    });
    await hive.submitGoal('Anything');
    expect(engine.calls[0]!.brain).toBeUndefined();
    expect(engine.calls[0]!.system).not.toContain('## The Brain');
  });
});
