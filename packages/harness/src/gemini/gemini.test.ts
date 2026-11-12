import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { ClaudeEvent } from '../claude/stream';
import { geminiAdapter } from '../engines/adapters';
import { routeCard } from '../hive/router';
import type { EngineRequest } from '../hive/engine';
import { buildGeminiArgs, buildGeminiPolicy, buildGeminiSettings, geminiThinkingOverrides } from './args';
import { MIN_GEMINI_VERSION, checkGeminiAuth, detectGemini, hasMachinePolicies, machinePolicyDir } from './detect';
import { GeminiEngine } from './engine';
import { geminiExitError, runGemini, unsafeForGeminiEnv } from './run';
import { estimateGeminiCost, parseGeminiLine } from './stream';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const fake = here('./fake-gemini.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'insectoids-gemini-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let dirN = 0;
const fresh = (name: string): string => join(tmp, `${name}-${++dirN}`);

describe('Gemini CLI run config (verified against the 0.68.0 bundle)', () => {
  it('runs headless with the hive policy, only the hive MCP servers, no extensions, trusted for this session only', () => {
    expect(buildGeminiArgs({ model: 'flash', policyFile: '/run/policy.toml', readOnly: false })).toEqual([
      '-p', 'Do the task described above.',
      '-o', 'stream-json',
      '-m', 'flash',
      '--approval-mode', 'default',
      '--admin-policy', '/run/policy.toml',
      '--allowed-mcp-server-names', 'hive', 'brain', 'services',
      '-e', 'none',
      '--skip-trust',
    ]);
    expect(buildGeminiArgs({ policyFile: 'p', readOnly: true })).toContain('plan');
    expect(buildGeminiArgs({ policyFile: 'p', readOnly: false })).not.toContain('--yolo');
  });

  it('settings switch off hooks, usage statistics and AI-credit spending, and keep GEMINI.md out', () => {
    const s = buildGeminiSettings({ mcpServers: { hive: { command: 'node', args: ['tools.mjs'] } }, maxTurns: 40, effort: 'medium', contextFileName: '.insectoids-x.md' });
    expect(s).toMatchObject({
      mcpServers: { hive: { command: 'node', args: ['tools.mjs'] } },
      model: { maxSessionTurns: 40 },
      privacy: { usageStatisticsEnabled: false },
      billing: { overageStrategy: 'never' },
      context: { fileName: '.insectoids-x.md' },
      hooksConfig: { enabled: false },
      general: { enableAutoUpdate: false },
    });
    expect(JSON.stringify(s)).not.toMatch(/GEMINI\.md/);
  });

  it('maps effort to the thinking level (Gemini 3) and budget (Gemini 2.5)', () => {
    const level = (e: Parameters<typeof geminiThinkingOverrides>[0]) => JSON.stringify(geminiThinkingOverrides(e)[0]);
    expect(level('low')).toContain('"thinkingLevel":"LOW"');
    expect(level('medium')).toContain('"thinkingLevel":"LOW"');
    expect(level('high')).toContain('"thinkingLevel":"HIGH"');
    expect(JSON.stringify(geminiThinkingOverrides('max')[1])).toContain('"thinkingBudget":24576');
    expect(geminiThinkingOverrides('xhigh')[0]!.match).toEqual({ model: 'chat-base-3' });
  });

  it('the admin policy denies every built-in tool and allows only the hive and Brain servers', () => {
    const p = buildGeminiPolicy({ readOnly: false });
    expect(p).toMatch(/toolName = "\*"\ndecision = "deny"\npriority = 100/);
    expect(p).toMatch(/mcpName = "hive"\ndecision = "allow"\npriority = 900/);
    expect(p).toMatch(/mcpName = "brain"\ndecision = "allow"/);
    expect(p).toMatch(/mcpName = "services"\ndecision = "allow"/);
    expect(p).not.toMatch(/read_file/);
  });

  it('read-only policy: built-in read tools only, secrets denied, no hive tools', () => {
    const p = buildGeminiPolicy({ readOnly: true });
    expect(p).toMatch(/"read_file", "read_many_files", "list_directory", "glob", "grep_search"/);
    expect(p).toMatch(/argsPattern = '\(\\\.env\|/);
    expect(p).not.toMatch(/mcpName = "hive"/);
    expect(p).not.toMatch(/run_shell_command|write_file|replace/);
  });

  it('refuses env values Gemini CLI would expand ($VAR, %VAR%)', () => {
    expect(unsafeForGeminiEnv('{"workspace":"C:\\\\x"}')).toBe(false);
    expect(unsafeForGeminiEnv('a$HOME')).toBe(true);
    expect(unsafeForGeminiEnv('%USERPROFILE%\\x')).toBe(true);
    expect(unsafeForGeminiEnv('100% done')).toBe(false);
  });
});

describe('Gemini stream-json', () => {
  it('maps events into the hive event model', () => {
    expect(parseGeminiLine('{"type":"init","session_id":"s","model":"gemini-3-flash"}')).toEqual([{ kind: 'init', sessionId: 's', model: 'gemini-3-flash' }]);
    expect(parseGeminiLine('{"type":"message","role":"user","content":"prompt"}')).toEqual([]);
    expect(parseGeminiLine('{"type":"message","role":"assistant","content":"Hi","delta":true}')).toEqual([{ kind: 'delta', text: 'Hi' }]);
    expect(parseGeminiLine('{"type":"tool_use","tool_name":"mcp_hive_run_shell","tool_id":"t","parameters":{"command":"ls"}}')).toEqual([
      { kind: 'event', event: { kind: 'tool_use', id: 't', name: 'mcp_hive_run_shell', input: { command: 'ls' } } },
    ]);
    expect(parseGeminiLine('{"type":"tool_result","tool_id":"t","status":"error","error":{"type":"x","message":"Denied"}}')).toEqual([
      { kind: 'event', event: { kind: 'tool_result', toolUseId: 't', isError: true, content: 'Denied' } },
    ]);
    expect(parseGeminiLine('nope')).toEqual([]);
  });

  it('reads tokens (cached apart) and the models that ran from the result', () => {
    const [r] = parseGeminiLine(
      JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 3000, output_tokens: 500, cached: 1000, input: 2000, duration_ms: 9, tool_calls: 3, models: { 'gemini-3-flash': {} } } }),
    );
    expect(r).toMatchObject({ kind: 'result', ok: true, usage: { input: 2000, output: 500, cacheRead: 1000, cacheWrite: 0 }, durationMs: 9, toolCalls: 3, models: ['gemini-3-flash'] });
  });

  it('estimates cost from list prices (Gemini reports none)', () => {
    const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };
    expect(estimateGeminiCost(['gemini-3.1-flash-lite'], usage)).toBeCloseTo(0.5);
    expect(estimateGeminiCost(['gemini-3-flash'], usage)).toBeCloseTo(2.8);
    expect(estimateGeminiCost(['gemini-3-pro-preview'], usage)).toBeCloseTo(14);
    // Helper models: priced at the dearest that ran.
    expect(estimateGeminiCost(['gemini-3.1-flash-lite', 'gemini-3-pro-preview'], usage)).toBeCloseTo(14);
  });

  it('turns exit codes into run errors', () => {
    expect(geminiExitError(0)).toBeUndefined();
    expect(geminiExitError(41)).toBe('auth');
    expect(geminiExitError(53)).toBe('limit');
    expect(geminiExitError(55)).toBe('model-error');
    expect(geminiExitError(9)).toBe('crash');
  });
});

describe('finding Gemini CLI and its sign-in', () => {
  const pkg = (version: string) => JSON.stringify({ name: '@google/gemini-cli', version });

  it('finds the npm package, its bundle and a Node.js 20+ (Windows: no npm call, so no shell)', async () => {
    const files: Record<string, string> = {
      [join('/appdata', 'npm', 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js')]: '',
      [join('/appdata', 'npm', 'node_modules', '@google', 'gemini-cli', 'package.json')]: pkg('0.68.0'),
      [join('/bin', 'node.exe')]: '',
    };
    const calls: string[] = [];
    const install = await detectGemini({
      run: async (command) => {
        calls.push(command);
        return '';
      },
      exists: (p) => p in files,
      readFile: (p) => files[p] ?? '',
      runNode: async () => 'v24.15.0\n',
      env: { PATH: '/bin', APPDATA: '/appdata' },
      platform: 'win32',
    });
    expect(calls).toEqual([]);
    expect(install).toEqual({
      status: 'installed',
      script: join('/appdata', 'npm', 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js'),
      version: '0.68.0',
      node: join('/bin', 'node.exe'),
      nodeVersion: '24.15.0',
    });
  });

  it('reports outdated, no Node.js, and missing', async () => {
    const base = { run: async () => '/g\n', env: { PATH: '/bin' }, platform: 'linux' as const };
    const at = (v: string) => ({ [join('/g', '@google', 'gemini-cli', 'bundle', 'gemini.js')]: '', [join('/g', '@google', 'gemini-cli', 'package.json')]: pkg(v) });
    const old = at('0.66.0');
    expect(await detectGemini({ ...base, exists: (p) => p in old, readFile: (p) => old[p] ?? '', runNode: async () => 'v24.0.0' })).toMatchObject({ status: 'outdated', minimum: MIN_GEMINI_VERSION });
    const ok = { ...at('0.68.0'), [join('/bin', 'node')]: '' };
    expect(await detectGemini({ ...base, exists: (p) => p in ok, readFile: (p) => ok[p] ?? '', runNode: async () => 'v18.19.0' })).toMatchObject({ status: 'no-node' });
    expect(await detectGemini({ ...base, run: async () => { throw new Error('no npm'); }, exists: () => false, readFile: () => '', runNode: async () => '' })).toEqual({ status: 'missing' });
  });

  it('checks Google sign-in from the settings and the credentials file existing, never opening it', () => {
    const read: string[] = [];
    const settings = JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } });
    const deps = (credsExist: boolean) => ({
      home: '/h',
      exists: (p: string) => credsExist && p === join('/h', '.gemini', 'oauth_creds.json'),
      readFile: (p: string) => {
        read.push(p);
        return p.endsWith('settings.json') ? settings : 'SECRET';
      },
      env: {},
    });
    expect(checkGeminiAuth(deps(true))).toEqual({ signedIn: true, method: 'oauth-personal' });
    expect(checkGeminiAuth(deps(false))).toEqual({ signedIn: false, method: 'oauth-personal' });
    expect(read.every((p) => p.endsWith('settings.json'))).toBe(true);
    expect(checkGeminiAuth({ home: '/h', exists: () => false, readFile: () => '{}', env: {} })).toEqual({ signedIn: false, method: null });
  });

  it('refuses when the machine has its own admin policies (they would replace the hive policy)', () => {
    expect(machinePolicyDir('win32')).toBe('C:\\ProgramData\\gemini-cli\\policies');
    expect(machinePolicyDir('linux')).toBe('/etc/gemini-cli/policies');
    expect(hasMachinePolicies('win32', () => ['company.toml'])).toBe(true);
    expect(hasMachinePolicies('win32', () => ['readme.txt'])).toBe(false);
    expect(hasMachinePolicies('win32', () => { throw new Error('ENOENT'); })).toBe(false);
  });
});

describe('a run against a stand-in Gemini CLI', () => {
  const run = (mode: string, extra: Partial<Parameters<typeof runGemini>[0]> = {}) => {
    const report = join(tmp, `report-${++dirN}.json`);
    const runDir = fresh('run');
    const events: ClaudeEvent[] = [];
    const handle = runGemini({
      bin: { command: process.execPath, args: [fake] },
      cwd: tmp,
      prompt: 'Brief\n\n---\n\nWrite hello.txt',
      model: 'flash-lite',
      effort: 'medium',
      maxTurns: 30,
      mcpServers: { hive: { command: 'node', args: ['tools.mjs'], env: { INSECTOIDS_GUARD: '{"workspace":"w"}' } } },
      readOnly: false,
      runDir,
      env: { FAKE_GEMINI_MODE: mode, FAKE_GEMINI_REPORT: report, ELECTRON_RUN_AS_NODE: '1', INSECTOIDS_BRAIN_TOKEN: 'secret-token' },
      onEvent: (e) => events.push(e),
      ...extra,
    });
    const readReport = () => JSON.parse(readFileSync(report, 'utf8')) as Record<string, unknown> & { env: Record<string, string | null>; settings: Record<string, unknown>; policy: string; args: string[]; prompt: string };
    return { handle, events, readReport, runDir };
  };

  it('passes settings, policy and prompt; keeps Electron-as-Node and tokens out of its environment; cleans up', async () => {
    const { handle, events, readReport, runDir } = run('ok');
    const r = await handle.done;
    const rep = readReport();
    expect(rep.args).toContain('--admin-policy');
    expect(rep.policy).toMatch(/mcpName = "hive"/);
    expect(rep.settings).toMatchObject({ hooksConfig: { enabled: false }, mcpServers: { hive: { env: { INSECTOIDS_GUARD: '{"workspace":"w"}' } } } });
    expect(rep.prompt).toContain('Write hello.txt');
    expect(rep.env).toMatchObject({ ELECTRON_RUN_AS_NODE: null, INSECTOIDS_BRAIN_TOKEN: null, INSECTOIDS_GUARD: null, GEMINI_CLI_NO_RELAUNCH: 'true' });
    expect(existsSync(runDir)).toBe(false);
    expect(r).toMatchObject({ ok: true, model: 'gemini-3.1-flash-lite', models: ['gemini-3.1-flash-lite'], costEstimated: true, usage: { input: 2000, output: 500, cacheRead: 1000 } });
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.text).toContain('STATUS: DONE');
    // Deltas become whole text events; tool calls and the policy denial show in the lane.
    expect(events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text)).toEqual(['Working on it.', 'Done.\nSTATUS: DONE']);
    expect(events.some((e) => e.kind === 'tool_result' && e.isError && e.content === 'Denied by policy.')).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: 'result', isError: false });
  });

  it('turn limit → limit; sign-in error → auth; nonsense → crash', async () => {
    expect((await run('turns').handle.done).error).toBe('limit');
    expect((await run('auth').handle.done).error).toBe('auth');
    expect((await run('garbage').handle.done).error).toBe('crash');
  });

  it('stops at its time limit and when the Watchdog says so', async () => {
    expect((await run('hang', { timeoutMs: 700 }).handle.done).error).toBe('timeout');
    const h = run('hang').handle;
    setTimeout(() => h.stop(), 300);
    expect((await h.done).error).toBe('stopped');
  });

  it('refuses before starting when a server env value would be expanded by Gemini', async () => {
    const { handle, runDir } = run('ok', { mcpServers: { hive: { command: 'node', args: ['t'], env: { INSECTOIDS_GUARD: '{"workspace":"C:/$weird"}' } } } });
    const r = await handle.done;
    expect(r).toMatchObject({ ok: false, error: 'crash' });
    expect(r.stderrTail).toMatch(/would expand/);
    expect(existsSync(runDir)).toBe(false);
  });
});

describe('the Gemini engine and adapter', () => {
  const req = (role: EngineRequest['role'], brain = false): EngineRequest => ({
    role,
    agentId: 'Ant-3',
    cwd: '/work/card',
    system: 'ROLE BRIEF',
    task: 'THE TASK',
    route: { ...routeCard({ role: role === 'queen' ? 'queen' : role === 'inspector' ? 'inspector' : role, priority: 'normal', attempts: 0 }, { strongest: 'pro', standard: 'flash', light: 'flash-lite' }), engine: 'gemini' },
    guard: { workspace: '/work/card', home: '/h', noGo: [], network: 'docs' },
    ...(brain ? { brain: { endpoint: '\\\\.\\pipe\\b', token: 'tok', write: true, doors: { runtime: { command: 'electron', env: { ELECTRON_RUN_AS_NODE: '1' } }, mcpScript: '/doors/brain-mcp.mjs' } } } : {}),
  });

  it('gives each run the guarded hive tools and the Brain on Node.js, with the brief leading the prompt', async () => {
    const seen: Array<Parameters<typeof runGemini>[0]> = [];
    const engine = new GeminiEngine({
      node: '/bin/node',
      script: '/g/bundle/gemini.js',
      hiveTools: '/doors/hive-tools-mcp.mjs',
      runBase: '/runs',
      run: (o) => {
        seen.push(o);
        return { done: Promise.resolve({ ok: true, model: null, models: [], sessionId: null, text: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, numTurns: 0, durationMs: 0, exitCode: 0, stderrTail: '' }), stop: () => {} };
      },
    });
    await engine.run(req('coder', true)).done;
    const o = seen[0]!;
    expect(o.bin).toEqual({ command: '/bin/node', args: ['/g/bundle/gemini.js'] });
    expect(o.prompt).toBe('ROLE BRIEF\n\n---\n\nTHE TASK');
    expect(o.readOnly).toBe(false);
    expect(o.model).toBe('flash');
    expect(o.mcpServers['hive']).toMatchObject({ command: '/bin/node', args: ['/doors/hive-tools-mcp.mjs'], cwd: '/work/card' });
    expect(JSON.parse(o.mcpServers['hive']!.env!['INSECTOIDS_GUARD']!)).toMatchObject({ workspace: '/work/card', network: 'docs' });
    // The Brain door runs on Node too: Gemini CLI won't pass ELECTRON_RUN_AS_NODE to an MCP server.
    expect(o.mcpServers['brain']).toMatchObject({ command: '/bin/node', args: ['/doors/brain-mcp.mjs'], env: { INSECTOIDS_BRAIN_TOKEN: 'tok' } });
    expect(JSON.stringify(o.mcpServers)).not.toMatch(/ELECTRON_RUN_AS_NODE/);
    expect(o.mcpServers['services']).toBeUndefined();

    // A card with granted integrations also gets the services door, on Node, with the broker token in its env only.
    const services = { url: 'http://127.0.0.1:7', token: 'svc', granted: ['github'], door: { runtime: { command: 'electron', env: { ELECTRON_RUN_AS_NODE: '1' } }, mcpScript: '/doors/services-mcp.mjs' } };
    await engine.run({ ...req('coder', true), services }).done;
    expect(seen[1]!.mcpServers['services']).toEqual({
      command: '/bin/node',
      args: ['/doors/services-mcp.mjs'],
      env: { INSECTOIDS_BROKER_URL: 'http://127.0.0.1:7', INSECTOIDS_BROKER_TOKEN: 'svc' },
      timeout: expect.any(Number),
    });
  });

  it('without the hive tools it takes read-only work only, and refuses writers', async () => {
    const engine = new GeminiEngine({ node: 'node', script: 's', hiveTools: null, runBase: '/runs', run: () => ({ done: Promise.resolve({ ok: true } as never), stop: () => {} }) });
    const r = await engine.run(req('coder')).done;
    expect(r).toMatchObject({ ok: false, error: 'crash' });
    expect(r.stderrTail).toMatch(/read-only/);
    expect((await engine.run(req('researcher')).done).ok).toBe(true);
  });

  it('detection: ready, signed out, machine policies, missing; the guard depends on the hive tools', async () => {
    const tools = join(tmp, 'hive-tools-mcp.mjs');
    writeFileSync(tools, '');
    const installed = { status: 'installed' as const, script: 's', version: '0.68.0', node: 'node', nodeVersion: '24.0.0' };
    const make = (o: Partial<Parameters<typeof geminiAdapter>[0]> = {}) =>
      geminiAdapter({ hiveTools: tools, runBase: tmp, detect: async () => installed, auth: () => ({ signedIn: true, method: 'gemini-api-key' }), machinePolicies: () => false, ...o });
    const a = make();
    expect(a.capabilities).toMatchObject({ guard: 'policy-and-tools', reportsCost: false });
    expect(await a.detect!()).toMatchObject({ state: 'ready', version: '0.68.0', message: 'Gemini CLI 0.68.0 is ready.' });
    expect(a.create!()).toBeInstanceOf(GeminiEngine);
    expect(await make({ auth: () => ({ signedIn: false, method: null }) }).detect!()).toMatchObject({ state: 'signed-out' });
    // A personal Google sign-in: Google's server refuses it since 2026-06-18 (found in the first real smoke run).
    expect(await make({ auth: () => ({ signedIn: true, method: 'oauth-personal' }) }).detect!()).toMatchObject({
      state: 'signed-out',
      message: expect.stringMatching(/June 18, 2026.*Antigravity CLI.*paid Gemini API key/),
    });
    expect(await make({ machinePolicies: () => true }).detect!()).toMatchObject({ state: 'missing', message: expect.stringMatching(/admin policies/) });
    expect(await make({ detect: async () => ({ status: 'missing' }) }).detect!()).toMatchObject({ state: 'missing' });
    const noTools = make({ hiveTools: join(tmp, 'nope.mjs') });
    expect(noTools.capabilities.guard).toBe('read-only');
    expect(await noTools.detect!()).toMatchObject({ state: 'ready', message: expect.stringMatching(/read-only/) });
  });
});
