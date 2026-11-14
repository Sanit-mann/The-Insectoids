import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { opencodeAdapter } from '../engines/adapters';
import type { EngineRequest } from '../hive/engine';
import {
  FORBIDDEN_FLAGS,
  PASS_ENV,
  assertNoSubstitution,
  buildOpenCodeArgs,
  buildOpenCodeConfig,
  buildOpenCodeEnv,
  hivePermissions,
  mcpEnvironment,
  modelKeyFor,
} from './config';
import { blockingSystemConfig, candidatePaths, detectOpenCode, versionAtLeast } from './detect';
import { type LlmAccess, OpenCodeEngine, type ReadyProvider } from './engine';
import { runOpenCode } from './run';
import { estimateOpenCodeCost, parseOpenCodeLine } from './stream';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const FAKE = here('./fake-opencode.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'insectoids opencode '));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const tiers = { strongest: 'anthropic/claude-opus', standard: 'meta-llama/llama-3.3-70b', light: 'qwen/qwen3-8b' };
const BROKER = 'http://127.0.0.1:43210/llm/openrouter';
const hiveServer = { command: ['electron.exe', 'hive-tools.mjs'], environment: mcpEnvironment({ ELECTRON_RUN_AS_NODE: '1', INSECTOIDS_GUARD: '{"workspace":"C:\\\\w"}' }, 'C:\\ProgramData') };

/** The config is plain JSON for OpenCode; tests read it loosely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

describe('per-run config (OpenCode 2.2.6)', () => {
  const config = buildOpenCodeConfig({ baseUrl: BROKER, tiers, mcpServers: { hive: hiveServer, brain: hiveServer }, readOnly: false, maxSteps: 40 }) as Json;

  it('denies every tool first, then allows only the hive MCP tools, also inside the hive agent', () => {
    expect(config['permissions']).toEqual([
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'hive_*', resource: '*', effect: 'allow' },
      { action: 'brain_*', resource: '*', effect: 'allow' },
    ]);
    expect(config['agents'].hive).toMatchObject({ mode: 'primary', permissions: config['permissions'], steps: 40 });
    expect(config['default_agent']).toBe('hive');
  });

  it('keeps built-in tools, web search, skills and auto-detected local providers from loading', () => {
    expect(config['plugins']).toEqual(expect.arrayContaining(['-opencode.tool.*', '-opencode.websearch.*', '-opencode.skill', '-opencode.provider.ollama', '-opencode.provider.lmstudio']));
    // OpenCode 2.2.5 policy actions (last match wins): only our provider, its own integration, the hive's MCP
    // servers, and no skills. A bare integration "*" deny also covers providers, hence the hive-or allow.
    expect(config['policies']).toEqual([
      { action: 'provider.use', resource: '*', effect: 'deny' },
      { action: 'provider.use', resource: 'hive-or', effect: 'allow' },
      { action: 'integration.use', resource: '*', effect: 'deny' },
      { action: 'integration.use', resource: 'hive-or', effect: 'allow' },
      { action: 'mcp.use', resource: '*', effect: 'deny' },
      { action: 'mcp.use', resource: 'hive', effect: 'allow' },
      { action: 'mcp.use', resource: 'brain', effect: 'allow' },
      { action: 'skill.use', resource: '*', effect: 'deny' },
    ]);
    // The provider's integration counts as connected through the run pass's variable (never a real key).
    expect((config['providers'] as Record<string, { env?: string[] }>)['hive-or']?.env).toEqual(['HIVE_RUN_PASS']);
    expect(config).toMatchObject({ update: 'disable', share: 'disabled', snapshots: false, lsp: false, formatter: false, warming: false });
  });

  it('talks to the broker with the run pass, never a key; models keyed by tier (ids may contain "/")', () => {
    expect(config['providers']['hive-or']).toMatchObject({
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: BROKER, apiKey: `{env:${PASS_ENV}}` },
    });
    expect(config['providers']['hive-or'].models.standard.modelID).toBe('meta-llama/llama-3.3-70b');
    expect(modelKeyFor(tiers, 'qwen/qwen3-8b')).toBe('light');
    expect(modelKeyFor(tiers, 'unknown')).toBe('standard');
  });

  it('MCP servers list tools directly and blank the pass and OpenCode folders for their children', () => {
    const hive = config['mcp'].servers.hive;
    expect(hive).toMatchObject({ type: 'local', codemode: false });
    expect(hive.environment).toMatchObject({ [PASS_ENV]: '', OPENCODE_CONFIG_CONTENT: '', XDG_CONFIG_HOME: '', ProgramData: 'C:\\ProgramData', ELECTRON_RUN_AS_NODE: '1' });
  });

  it('read-only runs get no hive tools at all (no file access)', () => {
    const ro = buildOpenCodeConfig({ baseUrl: BROKER, tiers, mcpServers: { hive: hiveServer, brain: hiveServer }, readOnly: true }) as Json;
    expect(Object.keys(ro['mcp'].servers)).toEqual(['brain']);
    expect(ro['permissions']).toEqual(hivePermissions(['brain']));
  });

  it('refuses any value OpenCode would rewrite ({env:…} / {file:…})', () => {
    const evil = { command: ['x'], environment: { INSECTOIDS_GUARD: '{"noGo":["{file:~/.ssh/id_rsa}"]}' } };
    expect(() => buildOpenCodeConfig({ baseUrl: BROKER, tiers, mcpServers: { hive: evil }, readOnly: false })).toThrow(/would replace/);
    expect(() => buildOpenCodeConfig({ baseUrl: BROKER, tiers: { ...tiers, light: '{env:OPENAI_API_KEY}' }, mcpServers: {}, readOnly: false })).toThrow(/would replace/);
    expect(() => assertNoSubstitution({ apiKey: `{env:${PASS_ENV}}` })).not.toThrow();
  });
});

describe('command line', () => {
  it('runs privately (--standalone), as JSON, as the hive agent, on the run provider', () => {
    expect(buildOpenCodeArgs({ modelKey: 'light', title: 'Write\nhello' })).toEqual([
      'run', '--standalone', '--format', 'json', '--agent', 'hive', '-m', 'hive-or/light', '--title', 'Write hello',
    ]);
  });

  it('never passes an auto-approve flag, and a title can never start with a dash', () => {
    for (const title of ['--yolo', '--auto --dangerously-skip-permissions', ' -x', '']) {
      const args = buildOpenCodeArgs({ modelKey: 'standard', title });
      for (const f of FORBIDDEN_FLAGS) expect(args.filter((a) => a === f)).toEqual([]);
      expect(args.at(-1)?.startsWith('-')).toBe(false);
    }
    expect(buildOpenCodeArgs({ modelKey: 'standard', title: '--yolo' }).at(-1)).toBe('yolo');
  });
});

describe('environment', () => {
  const base = {
    PATH: '/bin',
    PROGRAMDATA: 'C:\\ProgramData',
    OPENAI_API_KEY: 'sk-real',
    OPENROUTER_API_KEY: 'or-real',
    GEMINI_API_KEY: 'g',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x',
    ELECTRON_RUN_AS_NODE: '1',
    OPENCODE_CONFIG: '/home/me/opencode.json',
    INSECTOIDS_BROKER_TOKEN: 't',
    HOME: '/home/me',
  };
  const env = buildOpenCodeEnv({ base, runDir: 'C:\\runs\\r1', workspace: 'C:\\w', pass: 'pass_1', config: '{}', platform: 'win32' });

  it('drops provider keys, telemetry, Electron-as-Node and the user OpenCode config', () => {
    for (const k of ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'ELECTRON_RUN_AS_NODE', 'OPENCODE_CONFIG', 'INSECTOIDS_BROKER_TOKEN']) {
      expect(env[k], k).toBeUndefined();
    }
    expect(env['PATH']).toBe('/bin');
  });

  it('points every OpenCode folder and ProgramData at the run folder (one ProgramData, any case)', () => {
    expect(env).toMatchObject({
      XDG_CONFIG_HOME: 'C:\\runs\\r1\\config',
      OPENCODE_CONFIG_DIR: 'C:\\runs\\r1\\opencode',
      ProgramData: 'C:\\runs\\r1\\programdata',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DB: ':memory:',
      PWD: 'C:\\w',
      [PASS_ENV]: 'pass_1',
    });
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PROGRAMDATA')).toEqual(['ProgramData']);
  });
});

describe('JSON events', () => {
  it('reads text, tools, steps with cost and tokens, and errors with their HTTP status', () => {
    expect(parseOpenCodeLine('{"type":"step_start","sessionID":"ses_9","part":{}}')).toEqual([{ kind: 'session', sessionId: 'ses_9' }]);
    expect(parseOpenCodeLine('{"type":"text","part":{"text":"Hi"}}')).toEqual([{ kind: 'event', event: { kind: 'text', text: 'Hi' } }]);
    const tool = parseOpenCodeLine('{"type":"tool_use","part":{"id":"t","tool":"hive_read_file","state":{"status":"error","input":{"path":".env"},"error":"Blocked by the guard"}}}');
    expect(tool[1]).toEqual({ kind: 'event', event: { kind: 'tool_result', toolUseId: 't', isError: true, content: 'Blocked by the guard' } });
    expect(parseOpenCodeLine('{"type":"step_finish","part":{"cost":0.01,"tokens":{"input":10,"output":5,"reasoning":2,"cache":{"read":3,"write":1}}}}')).toEqual([
      { kind: 'step', costUsd: 0.01, usage: { input: 10, output: 7, cacheRead: 3, cacheWrite: 1 } },
    ]);
    expect(parseOpenCodeLine('{"type":"error","error":{"type":"api","message":"Unauthorized","status":401}}')).toEqual([{ kind: 'error', message: 'Unauthorized', status: 401, type: 'api' }]);
    expect(parseOpenCodeLine('not json')).toEqual([]);
  });

  it('estimates cost only for remote providers; local ones cost nothing', () => {
    expect(estimateOpenCodeCost({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, true)).toBe(0);
    expect(estimateOpenCodeCost({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, false)).toBeGreaterThan(0);
  });
});

describe('finding OpenCode', () => {
  it('finds the npm package exe, never a .cmd launcher, and checks the version (no shell)', async () => {
    const exe = join('/appdata', 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
    const paths = candidatePaths({ env: { APPDATA: '/appdata', PATH: '/bin' }, platform: 'win32' });
    expect(paths[0]).toBe(exe);
    expect(paths.some((p) => p.endsWith('.cmd'))).toBe(false);
    const found = await detectOpenCode({ exists: (p) => p === exe, version: async () => 'opencode v2.2.6\n', env: { APPDATA: '/appdata' }, platform: 'win32' });
    expect(found).toEqual({ status: 'installed', command: exe, version: '2.2.6' });
    // 2.2.5 starts a run before local MCP servers register their tools (fixed in 2.2.6): too old for the hive.
    const old = await detectOpenCode({ exists: (p) => p === exe, version: async () => 'opencode v2.2.5', env: { APPDATA: '/appdata' }, platform: 'win32' });
    expect(old).toMatchObject({ status: 'outdated', minimum: '2.2.6' });
    expect(await detectOpenCode({ exists: () => false, env: {}, platform: 'win32' })).toEqual({ status: 'missing' });
    expect(versionAtLeast('2.10.0', '2.2.1')).toBe(true);
  });

  it('refuses machine-wide configs that can’t be redirected (macOS, Linux); Windows redirects ProgramData', () => {
    expect(blockingSystemConfig('linux', (p) => p === '/etc/opencode')).toBe('/etc/opencode');
    expect(blockingSystemConfig('darwin', (p) => p.endsWith('ai.opencode.managed.plist'), 'sam')).toMatch(/managed\.plist$/);
    expect(blockingSystemConfig('linux', () => false)).toBeNull();
    expect(blockingSystemConfig('win32', () => true)).toBeNull();
  });
});

const usage = { model: 'meta-llama/llama-3.3-70b-instruct:free', input: 2000, output: 400, cacheRead: 100, calls: 2 };
const runOpts = (dir: string, extra: Record<string, unknown> = {}) => ({
  command: process.execPath,
  commandArgs: [FAKE],
  cwd: tmp,
  prompt: 'Brief\n\n---\n\nDo the card.',
  title: 'Write hello.txt',
  model: tiers.standard,
  tiers,
  baseUrl: BROKER,
  pass: 'pass_abc',
  local: false,
  mcpServers: { hive: hiveServer },
  readOnly: false,
  runDir: join(tmp, dir),
  timeoutMs: 20_000,
  env: { ...process.env, FAKE_OPENCODE_REPORT: join(tmp, `${dir}.json`), OPENAI_API_KEY: 'sk-should-be-dropped', ELECTRON_RUN_AS_NODE: '1' },
  usage: async () => usage,
  ...extra,
});

describe('a run through a stand-in OpenCode', () => {
  it('runs with every safety rule in place; the broker’s model and tokens win over the stream', async () => {
    const r = await runOpenCode(runOpts('ok')).done;
    const report = JSON.parse(readFileSync(join(tmp, 'ok.json'), 'utf8'));
    expect(report.problems).toEqual([]);
    expect(report.prompt).toBe('Brief\n\n---\n\nDo the card.');
    expect(report.env.PWD).toBe(tmp);
    expect(r).toMatchObject({ ok: true, models: [usage.model], usage: { input: 2000, output: 400, cacheRead: 100 }, costEstimated: true, sessionId: 'ses_1' });
    expect(r.text).toMatch(/STATUS: DONE/);
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it('a 401 from the provider is a sign-in problem; a crash is a crash; a hang is stopped by the timeout', async () => {
    expect((await runOpenCode(runOpts('auth', { env: { ...process.env, FAKE_OPENCODE_MODE: 'auth' } })).done).error).toBe('auth');
    expect((await runOpenCode(runOpts('crash', { env: { ...process.env, FAKE_OPENCODE_MODE: 'crash' } })).done).error).toBe('crash');
    expect((await runOpenCode(runOpts('hang', { env: { ...process.env, FAKE_OPENCODE_MODE: 'hang' }, timeoutMs: 1500 })).done).error).toBe('timeout');
  });

  it('a broken rule makes the stand-in refuse (it would catch a config regression)', async () => {
    const r = await runOpenCode(runOpts('broken', { baseUrl: 'https://openrouter.ai/api/v1' })).done;
    expect(r.ok).toBe(false);
    expect(r.stderrTail).toMatch(/broken rules: provider base URL is the local broker/);
  });

  it('cleans up its run folder', async () => {
    await runOpenCode(runOpts('clean')).done;
    expect(() => readFileSync(join(tmp, 'clean', 'x'))).toThrow();
  });
});

const req = (role: EngineRequest['role']): EngineRequest => ({
  role,
  agentId: 'Ant-01',
  title: 'Write hello.txt',
  cwd: tmp,
  system: 'Brief',
  task: 'Do it',
  route: { engine: 'opencode', tier: 'standard', model: tiers.standard, effort: 'medium', reason: 'rule: test', maxTurns: 10, maxBudgetUsd: 1, timeoutMs: 20_000 },
  guard: { workspace: tmp, home: tmp, noGo: [], network: 'none' },
});

function fakeLlm(): LlmAccess & { issued: string[]; revoked: string[] } {
  const issued: string[] = [];
  const revoked: string[] = [];
  return {
    issued,
    revoked,
    issue: async (runId) => {
      issued.push(runId);
      return { baseUrl: BROKER, pass: `pass_${issued.length}` };
    },
    usage: async () => usage,
    revoke: async (pass) => {
      revoked.push(pass);
    },
  };
}

describe('the OpenCode engine and adapter', () => {
  const provider: ReadyProvider = { id: 'openrouter', label: 'OpenRouter', local: false, models: tiers };

  it('gets a broker pass per run and always revokes it, also when the run fails', async () => {
    const llm = fakeLlm();
    const engine = new OpenCodeEngine({ command: process.execPath, commandArgs: [FAKE], hiveTools: 'hive-tools.mjs', runtime: { command: 'electron' }, provider: () => provider, llm, runBase: tmp });
    expect((await engine.run(req('coder')).done).ok).toBe(true);
    const failing = new OpenCodeEngine({ command: join(tmp, 'no-such-opencode.exe'), hiveTools: 'hive-tools.mjs', runtime: { command: 'electron' }, provider: () => provider, llm, runBase: tmp });
    expect((await failing.run(req('coder')).done).ok).toBe(false);
    expect(llm.issued).toHaveLength(2);
    expect(llm.revoked).toEqual(['pass_1', 'pass_2']);
  });

  it('without hive tools it refuses writer work; without a provider it refuses as signed out', async () => {
    const llm = fakeLlm();
    const ro = new OpenCodeEngine({ command: process.execPath, commandArgs: [FAKE], hiveTools: null, runtime: { command: 'electron' }, provider: () => provider, llm, runBase: tmp });
    expect((await ro.run(req('coder')).done).stderrTail).toMatch(/read-only/);
    const none = new OpenCodeEngine({ command: process.execPath, hiveTools: 'x', runtime: { command: 'electron' }, provider: () => null, llm, runBase: tmp });
    expect((await none.run(req('coder')).done).error).toBe('auth');
    expect(llm.issued).toEqual([]);
  });

  it('detection: missing, outdated, machine config, no provider, ready (and read-only without the tools)', async () => {
    const tools = join(tmp, 'hive-tools-mcp.mjs');
    writeFileSync(tools, '');
    const installed = { status: 'installed' as const, command: 'opencode.exe', version: '2.2.1' };
    const make = (o: Partial<Parameters<typeof opencodeAdapter>[0]> = {}) =>
      opencodeAdapter({ hiveTools: tools, runtime: { command: 'electron' }, runBase: tmp, providers: async () => [provider], llm: fakeLlm(), detect: async () => installed, systemConfig: () => null, ...o });
    expect(await make({ detect: async () => ({ status: 'missing' }) }).detect!()).toMatchObject({ state: 'missing' });
    expect(await make({ detect: async () => ({ status: 'outdated', command: 'x', version: '2.0.0', minimum: '2.2.1' }) }).detect!()).toMatchObject({ state: 'outdated' });
    expect(await make({ systemConfig: () => '/etc/opencode' }).detect!()).toMatchObject({ state: 'missing', message: expect.stringMatching(/machine-wide/) });
    expect(await make({ providers: async () => [] }).detect!()).toMatchObject({ state: 'signed-out', message: expect.stringMatching(/API providers tab/) });
    expect(await make({ providers: async () => Promise.reject(new Error('main not ready')) }).detect!()).toMatchObject({ state: 'signed-out' });
    const a = make();
    expect(await a.detect!()).toMatchObject({ state: 'ready', message: 'OpenCode 2.2.1 is ready with OpenRouter.' });
    expect(a.capabilities).toMatchObject({ guard: 'policy-and-tools', reportsCost: true });
    expect(a.models).toEqual(tiers);
    expect(a.create!()).toBeInstanceOf(OpenCodeEngine);
    const noTools = make({ hiveTools: join(tmp, 'nope.mjs') });
    expect(noTools.capabilities.guard).toBe('read-only');
  });
});
