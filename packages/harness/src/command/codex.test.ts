import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandAdapter } from './adapter';
import { buildCommandInvocation } from './args';
import { CODEX_PRESET, CURSOR_PRESET, codexMcpWiring, codexNativeBinary, parseCodexLine } from './codex';
import { checkCommandSignIn, detectCommand } from './detect';
import { isForbiddenArg, unguardedReason } from './preset';

const runDir = 'C:\\Users\\u\\AppData\\Roaming\\The Insectoids\\hive\\codex-runs\\worker-1-ab12';
const servers = {
  hive: { command: 'C:\\Program Files\\The Insectoids\\The Insectoids.exe', args: ['C:\\app\\hive-tools-mcp.mjs'], env: { ELECTRON_RUN_AS_NODE: '1', INSECTOIDS_GUARD: '{"workspace":"C:\\\\work"}' }, cwd: 'C:\\work' },
  brain: { command: 'C:\\Program Files\\The Insectoids\\The Insectoids.exe', args: ['C:\\app\\brain-mcp.mjs'], env: { ELECTRON_RUN_AS_NODE: '1', INSECTOIDS_BRAIN_TOKEN: 'secret-token' } },
};
const build = (readOnly = false) =>
  buildCommandInvocation(CODEX_PRESET, { prompt: 'Brief\n\n---\n\nFix it.', model: null, effort: 'high', maxTurns: 30, mcpServers: servers, readOnly, runDir, platform: 'win32' });

describe('the Codex preset (Phase 4 B3)', () => {
  it('is guarded: read-only sandbox, approvals refused, its own tools off, nothing that bypasses that', () => {
    expect(unguardedReason(CODEX_PRESET)).toBeNull();
    const g = CODEX_PRESET.guard!.disableBuiltinTools;
    expect(g.slice(0, 2)).toEqual(['--sandbox', 'read-only']);
    expect(g).toEqual(expect.arrayContaining(['approval_policy="never"', 'web_search="disabled"']));
    for (const f of ['shell_tool', 'unified_exec', 'multi_agent', 'hooks', 'plugins', 'apps', 'browser_use', 'computer_use']) {
      expect(g[g.indexOf(f) - 1]).toBe('--disable');
    }
    for (const a of [...CODEX_PRESET.headlessArgs, ...g]) expect(isForbiddenArg(a, CODEX_PRESET.forbiddenArgs)).toBe(false);
    expect(CODEX_PRESET.headlessArgs).toEqual(expect.arrayContaining(['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config']));
  });

  it('the command line: prompt on stdin, the hive servers by -c, their variables by name only, effort', () => {
    const inv = build();
    expect(inv.stdin).toBe('Brief\n\n---\n\nFix it.');
    const line = inv.args.join(' ');
    expect(line).not.toContain('Fix it');
    // Secrets never on the command line: the variables go into Codex's environment and are named in env_vars.
    expect(line).not.toContain('secret-token');
    expect(line).not.toContain('INSECTOIDS_GUARD":');
    expect(inv.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', INSECTOIDS_GUARD: '{"workspace":"C:\\\\work"}', INSECTOIDS_BRAIN_TOKEN: 'secret-token' });
    expect(inv.args).toEqual(
      expect.arrayContaining([
        'mcp_servers.hive.command="C:\\\\Program Files\\\\The Insectoids\\\\The Insectoids.exe"',
        'mcp_servers.hive.args=["C:\\\\app\\\\hive-tools-mcp.mjs"]',
        'mcp_servers.hive.env_vars=["ELECTRON_RUN_AS_NODE","INSECTOIDS_GUARD"]',
        'mcp_servers.hive.cwd="C:\\\\work"',
        'mcp_servers.hive.default_tools_approval_mode="approve"',
        'mcp_servers.brain.env_vars=["ELECTRON_RUN_AS_NODE","INSECTOIDS_BRAIN_TOKEN"]',
        'model_reasoning_effort="high"',
      ]),
    );
    // No model flag: the account's default model.
    expect(inv.args).not.toContain('-m');
  });

  it('a read-only run gets no hive tools', () => {
    const inv = build(true);
    expect(inv.args.join(' ')).not.toContain('mcp_servers.hive.');
    expect(inv.args.join(' ')).toContain('mcp_servers.brain.');
    expect(inv.env['INSECTOIDS_GUARD']).toBeUndefined();
  });

  it('two servers needing different values for one variable are refused', () => {
    expect(() => codexMcpWiring({ hive: { command: 'a', args: [], env: { X: '1' } }, brain: { command: 'a', args: [], env: { X: '2' } } })).toThrow(/different values for X/);
  });

  it('reads Codex’s events (lines recorded from Codex 0.166.0)', () => {
    expect(parseCodexLine('{"type":"thread.started","thread_id":"01a1"}')).toEqual([]);
    expect(parseCodexLine('{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Done.\\nSTATUS: DONE"}}')).toEqual([{ kind: 'text', text: 'Done.\nSTATUS: DONE' }]);
    expect(parseCodexLine('{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `fake-model` not found."}}')).toEqual([]);
    expect(parseCodexLine('{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"hive","tool":"write_file","arguments":{"path":"a.txt"},"status":"in_progress"}}')).toEqual([
      { kind: 'tool', name: 'hive_write_file', id: 'item_1', input: { path: 'a.txt' } },
    ]);
    expect(parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":2000,"cached_input_tokens":400,"cache_write_input_tokens":0,"output_tokens":40,"reasoning_output_tokens":10}}')).toEqual([
      { kind: 'usage', usage: { input: 1600, output: 40, cacheRead: 400, cacheWrite: 0 } },
      { kind: 'final', ok: true },
    ]);
    const failed = parseCodexLine('{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"}}');
    expect(failed[0]).toMatchObject({ kind: 'error', auth: true });
    expect(failed[1]).toMatchObject({ kind: 'final', ok: false });
    expect(parseCodexLine('{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized)"}')).toEqual([]);
    expect(parseCodexLine('{"type":"error","message":"You have hit your usage limit."}')[0]).toMatchObject({ quota: true });
    expect(parseCodexLine('nope')).toEqual([]);
  });
});

describe('finding Codex on this computer', () => {
  const npm = 'C:\\Users\\u\\AppData\\Roaming\\npm';
  const script = join(npm, 'node_modules\\@openai\\codex\\bin\\codex.js');
  const native = join(npm, 'node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe');
  const shim = '@ECHO off\r\nGOTO start\r\n:start\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';

  it('starts the native program behind npm’s launcher; signed in only when its own status says so', async () => {
    const files: Record<string, string> = { [join(npm, 'codex.cmd')]: shim, [script]: '', [native]: '', [join(npm, 'node.exe')]: '' };
    const found = await detectCommand(CODEX_PRESET, {
      exists: (f) => f in files,
      readFile: (f) => files[f] ?? '',
      run: async () => 'codex-cli 0.166.0',
      env: { PATH: npm },
      platform: 'win32',
    });
    expect(found).toEqual({ status: 'installed', command: native, args: [], version: '0.166.0' });
    expect(codexNativeBinary(script, () => false, 'win32', 'x64')).toBeNull();
    expect(codexNativeBinary(script, (p) => p === native, 'win32', 'x64')).toBe(native);
    // "Not logged in" (exit 1, recorded) must not read as signed in.
    expect(await checkCommandSignIn(CODEX_PRESET, { command: native, args: [] }, { run: async () => 'WARNING: proceeding\nNot logged in\n' })).toBe(false);
    expect(await checkCommandSignIn(CODEX_PRESET, { command: native, args: [] }, { run: async () => 'Logged in using ChatGPT\n' })).toBe(true);
  });

  it('as an engine: guarded with the hive tools, a subscription, untested, and starting off', () => {
    const a = commandAdapter(CODEX_PRESET, { hiveTools: 'hive-tools.mjs', runtime: { command: 'electron.exe' }, runBase: 'C:\\runs', exists: () => true });
    expect(a).toMatchObject({ id: 'codex', startsOff: true, capabilities: { guard: 'policy-and-tools', mcp: true, subscription: true, effort: ['low', 'medium', 'high'] } });
  });
});

describe('the Cursor agent CLI (Phase 4 B3)', () => {
  it('is listed with its real install and sign-in, and never detected or run: it can’t be guarded yet', () => {
    expect(unguardedReason(CURSOR_PRESET)).toMatch(/can't be guarded yet; it will run inside a container/);
    const a = commandAdapter(CURSOR_PRESET, { hiveTools: 'hive-tools.mjs', runtime: { command: 'electron.exe' }, runBase: 'C:\\runs' });
    expect(a.detect).toBeUndefined();
    expect(a.capabilities.guard).toBeNull();
    expect(a.unavailableReason).toMatch(/Cursor agent CLI can't be guarded yet/);
    expect(a.install?.command).toBe("irm 'https://cursor.com/install?win32=true' | iex");
    expect(a.signIn?.command).toBe('agent login');
  });
});
