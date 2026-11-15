import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildCommandInvocation } from './args';
import { commandAdapter } from './adapter';
import {
  COPILOT_PRESET,
  HIVE_MCP_TOOLS,
  NO_TOOLS,
  copilotModelArgs,
  copilotNativeBinary,
  parseCopilotLine,
  parseCopilotUsage,
} from './copilot';
import { detectCommand } from './detect';
import { fakeCommandPreset } from './fake-preset';
import { isForbiddenArg, unguardedReason } from './preset';
import { buildCommandEnv, runCommand } from './run';

const tmp = mkdtempSync(join(tmpdir(), 'insectoids copilot '));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const runDir = 'C:\\Users\\u\\AppData\\Roaming\\The Insectoids\\hive\\copilot-runs\\worker-1-ab12';
const servers = {
  hive: { command: 'electron.exe', args: ['hive-tools.mjs'], env: { ELECTRON_RUN_AS_NODE: '1', INSECTOIDS_GUARD: '{"workspace":"w"}' }, cwd: 'C:\\work' },
  brain: { command: 'electron.exe', args: ['brain-mcp.mjs'], env: { INSECTOIDS_BRAIN_TOKEN: 't' } },
  services: { command: 'electron.exe', args: ['services-mcp.mjs'], env: {} },
};
const build = (over: { readOnly?: boolean; servers?: typeof servers | Record<string, never> } = {}) =>
  buildCommandInvocation(COPILOT_PRESET, {
    prompt: 'Brief\n\n---\n\nFix the bug.',
    model: 'auto:balance',
    effort: 'high',
    maxTurns: 30,
    mcpServers: over.servers ?? servers,
    readOnly: over.readOnly ?? false,
    runDir,
    platform: 'win32',
  });
const allowlists = (args: string[]): string[] => args.filter((a) => a.startsWith('--available-tools='));

describe('the Copilot preset (Phase 4 B2)', () => {
  it('is guarded: its own tools hidden and denied, no flag that approves everything', () => {
    expect(unguardedReason(COPILOT_PRESET)).toBeNull();
    for (const a of [...COPILOT_PRESET.headlessArgs, ...COPILOT_PRESET.guard!.disableBuiltinTools]) {
      expect(isForbiddenArg(a, COPILOT_PRESET.forbiddenArgs)).toBe(false);
    }
    expect(COPILOT_PRESET.guard!.disableBuiltinTools).toEqual([`--available-tools=${NO_TOOLS}`, '--deny-tool=shell', '--deny-tool=write', '--deny-tool=url']);
    expect(COPILOT_PRESET.headlessArgs).toEqual(expect.arrayContaining(['--output-format=json', '--no-auto-update', '--disable-builtin-mcps', '--no-ask-user']));
  });

  it('the command line: prompt on stdin, the exact hive tools allowed, MCP config in the run folder, model and effort', () => {
    const inv = build();
    expect(inv.stdin).toBe('Brief\n\n---\n\nFix the bug.');
    expect(inv.args.join(' ')).not.toContain('Fix the bug');
    // The sentinel first (no tools at all), then exactly the hive's tools, named as Copilot names MCP tools.
    const lists = allowlists(inv.args);
    expect(lists[0]).toBe(`--available-tools=${NO_TOOLS}`);
    const tools = lists[1]!.slice('--available-tools='.length).split(',');
    expect(tools).toContain('hive-write_file');
    expect(tools).toContain('brain-brain_search');
    expect(tools).toContain('services-call_service');
    expect(tools).toHaveLength(HIVE_MCP_TOOLS.hive.length + HIVE_MCP_TOOLS.brain.length + HIVE_MCP_TOOLS.services.length);
    expect(inv.args).toEqual(expect.arrayContaining(['--allow-tool=hive', '--allow-tool=brain', '--allow-tool=services']));
    expect(inv.args).toContain(`--additional-mcp-config=@${runDir}\\copilot-mcp.json`);
    expect(inv.args).toEqual(expect.arrayContaining(['--model=auto', '--auto-tier=balance', '--usage-output-file', join(runDir, 'usage.json')]));
    const config = JSON.parse(inv.files.find((f) => f.path === 'copilot-mcp.json')!.content);
    expect(config.mcpServers.hive).toEqual({ type: 'local', command: 'electron.exe', args: ['hive-tools.mjs'], env: servers.hive.env, cwd: 'C:\\work', tools: ['*'] });
    expect(Object.keys(config.mcpServers)).toEqual(['hive', 'brain', 'services']);
  });

  it('a read-only run gets no hive tools at all (only the Brain and services)', () => {
    const inv = build({ readOnly: true });
    const tools = allowlists(inv.args)[1]!;
    expect(tools).not.toMatch(/hive-/);
    expect(tools).toMatch(/brain-brain_read/);
    expect(inv.args).not.toContain('--allow-tool=hive');
    expect(JSON.parse(inv.files[0]!.content).mcpServers.hive).toBeUndefined();
  });

  it('with no MCP servers the model sees no tools at all', () => {
    const inv = build({ readOnly: true, servers: {} });
    expect(allowlists(inv.args)).toEqual([`--available-tools=${NO_TOOLS}`]);
    expect(inv.files).toEqual([]);
  });

  it('the tool list matches what the hive’s MCP servers register', () => {
    const pkgs = { hive: 'hive-tools-mcp', brain: 'brain-mcp', services: 'services-mcp' } as const;
    for (const [server, pkg] of Object.entries(pkgs)) {
      const src = readFileSync(fileURLToPath(new URL(`../../../${pkg}/src/server.ts`, import.meta.url)), 'utf8');
      const registered = [...src.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
      expect(registered.sort()).toEqual([...HIVE_MCP_TOOLS[server as keyof typeof HIVE_MCP_TOOLS]].sort());
    }
  });

  it('Auto takes no effort level (a real run refused one); a named model does', () => {
    expect(build().args).not.toContain('--reasoning-effort');
    const named = buildCommandInvocation(COPILOT_PRESET, { prompt: 'x', model: 'gpt-6-luna', effort: 'high', mcpServers: {}, readOnly: true, runDir, platform: 'win32' });
    expect(named.args).toEqual(expect.arrayContaining(['--model=gpt-6-luna', '--reasoning-effort', 'high']));
  });

  it('model tiers use Auto profiles; a plain model name passes as is', () => {
    expect(copilotModelArgs('auto:intelligence')).toEqual(['--model=auto', '--auto-tier=intelligence']);
    expect(copilotModelArgs('gpt-5.2')).toEqual(['--model=gpt-5.2']);
    expect(() => buildCommandInvocation(COPILOT_PRESET, { prompt: 'x', model: '--yolo', mcpServers: {}, readOnly: true, runDir, platform: 'win32' })).toThrow(/read it as a flag/);
  });

  it('never passes COPILOT_ALLOW_ALL or assisted approval on, nor the hive’s own secrets', () => {
    const env = buildCommandEnv({ PATH: 'p', COPILOT_ALLOW_ALL: 'true', COPILOT_ASSISTED_APPROVAL: '1', INSECTOIDS_BRAIN_TOKEN: 's', GH_HOST: 'github.com' }, COPILOT_PRESET, {});
    expect(env).toEqual({ PATH: 'p', GH_HOST: 'github.com' });
  });
});

describe('reading Copilot’s output (lines recorded from Copilot CLI 1.0.105)', () => {
  it('whole messages become text; tool calls, session errors and the result', () => {
    expect(parseCopilotLine('{"type":"assistant.message_delta","data":{"messageId":"m","deltaContent":"Hello"}}')).toEqual([]);
    expect(parseCopilotLine('{"type":"assistant.message","data":{"content":"Hello from the fake model.","toolRequests":[]}}')).toEqual([{ kind: 'text', text: 'Hello from the fake model.' }]);
    expect(parseCopilotLine('{"type":"assistant.message","data":{"content":"","toolRequests":[{"name":"hive-read_file"}]}}')).toEqual([]);
    expect(
      parseCopilotLine('{"type":"tool.execution_start","data":{"toolCallId":"call_1","toolName":"hive-tools-echo","arguments":{"text":"ping"},"mcpServerName":"hive-tools","mcpToolName":"echo"}}'),
    ).toEqual([{ kind: 'tool', name: 'hive-tools-echo', id: 'call_1', input: { text: 'ping' } }]);
    expect(parseCopilotLine('{"type":"session.error","data":{"errorType":"query","message":"Could not connect to local model provider at http://127.0.0.1:9/v1."}}')).toEqual([
      { kind: 'error', message: 'Could not connect to local model provider at http://127.0.0.1:9/v1.' },
    ]);
    expect(parseCopilotLine('{"type":"session.error","data":{"errorType":"rate_limit","message":"You have exceeded your AI credits."}}')[0]).toMatchObject({ quota: true });
    expect(parseCopilotLine('{"type":"session.error","data":{"errorType":"authentication","message":"Not signed in"}}')[0]).toMatchObject({ auth: true });
    expect(parseCopilotLine('{"type":"result","sessionId":"d055","exitCode":0,"usage":{"premiumRequests":0}}')).toEqual([{ kind: 'final', ok: true, sessionId: 'd055' }]);
    expect(parseCopilotLine('{"type":"result","sessionId":"9ec6","exitCode":1}')).toEqual([{ kind: 'final', ok: false, sessionId: '9ec6' }]);
    expect(parseCopilotLine('not json')).toEqual([]);
    expect(parseCopilotLine('{"type":"session.skills_loaded","data":{}}')).toEqual([]);
  });

  it('token counts come from the usage file, summed over models', () => {
    const file = {
      totalNanoAiu: 0,
      modelMetrics: {
        'fake-model': { requests: { count: 2, cost: 0 }, usage: { inputTokens: 220, outputTokens: 17, cacheReadTokens: 50, cacheWriteTokens: 0 } },
        'other-model': { usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 4 } },
      },
    };
    // inputTokens include the cached ones: fresh input is (220 − 50) + (10 − 4).
    expect(parseCopilotUsage(file)).toEqual({ usage: { input: 176, output: 20, cacheRead: 50, cacheWrite: 4 }, models: ['fake-model', 'other-model'] });
    // The real run's numbers (2026-11-15).
    expect(parseCopilotUsage({ modelMetrics: { 'gpt-6-luna': { usage: { inputTokens: 2965, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 2962, reasoningTokens: 0 } } } })).toEqual({
      usage: { input: 3, output: 5, cacheRead: 0, cacheWrite: 2962 },
      models: ['gpt-6-luna'],
    });
    expect(parseCopilotUsage({})).toBeNull();
    expect(parseCopilotUsage('nope')).toBeNull();
  });

  it('the generic engine reads a usage file before removing the run folder', async () => {
    const preset = fakeCommandPreset({
      usageFile: {
        flag: '--usage-file',
        parse: (j) => {
          const t = (j as { tokens: { in: number; out: number }; model: string }).tokens;
          return { usage: { input: t.in, output: t.out }, models: [(j as { model: string }).model] };
        },
      },
    });
    const cwd = join(tmp, 'work');
    mkdirSync(cwd, { recursive: true });
    const handle = runCommand({
      preset,
      bin: { command: process.execPath, args: [fileURLToPath(new URL('./fake-command.mjs', import.meta.url))] },
      cwd,
      prompt: 'Hello',
      model: 'fake-medium',
      mcpServers: {},
      readOnly: true,
      runDir: join(tmp, 'runs', 'r1'),
    });
    const r = await handle.done;
    expect(r.ok).toBe(true);
    // The stream's 3000/500 plus the file's 700/30.
    expect(r.usage).toMatchObject({ input: 3700, output: 530 });
    expect(r.models).toEqual(expect.arrayContaining(['fake-medium-2026', 'fake-from-file']));
  });
});

describe('finding Copilot on this computer', () => {
  const npm = 'C:\\Users\\u\\AppData\\Roaming\\npm';
  const vscode = 'C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\copilot-shim';
  const loader = join(npm, 'node_modules\\@github\\copilot\\npm-loader.js');
  const native = join(npm, 'node_modules\\@github\\copilot\\node_modules\\@github\\copilot-win32-x64\\copilot.exe');
  const shim = '@ECHO off\r\nGOTO start\r\n:start\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@github\\copilot\\npm-loader.js" %*\r\n';

  it('skips VS Code’s stand-in and starts the native program behind npm’s launcher directly', async () => {
    const files: Record<string, string> = {
      [join(vscode, 'copilot.exe')]: '',
      [join(npm, 'copilot.cmd')]: shim,
      [loader]: '',
      [native]: '',
      [join(npm, 'node.exe')]: '',
    };
    const ran: string[] = [];
    const found = await detectCommand(COPILOT_PRESET, {
      exists: (f) => f in files,
      readFile: (f) => files[f] ?? '',
      run: async (command, args) => {
        ran.push(`${command} ${args.join(' ')}`);
        return 'GitHub Copilot CLI 1.0.105.\nRun \'copilot update\' to check for updates.';
      },
      env: { PATH: `${vscode};${npm}` },
      platform: 'win32',
    });
    expect(found).toEqual({ status: 'installed', command: native, args: [], version: '1.0.105' });
    expect(ran).toEqual([`${native} --version`]);
  });

  it('an older Copilot is outdated; the loader falls back to Node when the native package is missing', async () => {
    expect(copilotNativeBinary(loader, () => false, 'win32', 'x64')).toBeNull();
    expect(copilotNativeBinary('C:\\other\\cli.js', () => true, 'win32', 'x64')).toBeNull();
    expect(copilotNativeBinary(loader, (p) => p === native, 'win32', 'x64')).toBe(native);
    const exe = join(npm, 'copilot.exe');
    const r = await detectCommand(COPILOT_PRESET, {
      exists: (f) => f === exe,
      readFile: () => '',
      run: async () => 'GitHub Copilot CLI 1.0.99.',
      env: { PATH: npm },
      platform: 'win32',
    });
    expect(r).toEqual({ status: 'outdated', command: exe, version: '1.0.99', minimum: '1.0.105' });
  });

  it('as an engine: a subscription, guarded with the hive tools, effort levels, and untested until a person checks it', async () => {
    const a = commandAdapter(COPILOT_PRESET, {
      hiveTools: 'hive-tools.mjs',
      runtime: { command: 'electron.exe' },
      runBase: join(tmp, 'runs'),
      exists: () => true,
      detect: async () => ({ status: 'installed', command: native, args: [], version: '1.0.105' }),
    });
    expect(a.capabilities).toMatchObject({ guard: 'policy-and-tools', mcp: true, subscription: true, reportsCost: false });
    expect(a.capabilities.effort).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(a.models).toEqual({ strongest: 'auto:intelligence', standard: 'auto:balance', light: 'auto:efficiency' });
    const d = await a.detect!();
    expect(d.state).toBe('ready');
    expect(d.message).not.toMatch(/hasn’t been checked against the real program/);
  });
});
