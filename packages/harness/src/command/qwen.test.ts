import { describe, expect, it } from 'vitest';
import { commandAdapter } from './adapter';
import { buildCommandInvocation } from './args';
import { isForbiddenArg, unguardedReason } from './preset';
import { QWEN_BUILTIN_TOOLS, QWEN_NO_SERVERS, QWEN_PRESET, QWEN_SETTINGS_FILE, parseQwenLine, qwenWiring } from './qwen';
import { buildCommandEnv } from './run';

const runDir = 'C:\\Users\\u\\AppData\\Roaming\\The Insectoids\\hive\\qwen-runs\\worker-1-ab12';
const servers = {
  hive: { command: 'C:\\Program Files\\The Insectoids\\The Insectoids.exe', args: ['C:\\app\\hive-tools-mcp.mjs'], env: { ELECTRON_RUN_AS_NODE: '1', INSECTOIDS_GUARD: '{"workspace":"C:\\\\work"}' }, cwd: 'C:\\work' },
  brain: { command: 'C:\\Program Files\\The Insectoids\\The Insectoids.exe', args: ['C:\\app\\brain-mcp.mjs'], env: { ELECTRON_RUN_AS_NODE: '1', INSECTOIDS_BRAIN_TOKEN: 'secret-token' } },
  services: { command: 'C:\\Program Files\\The Insectoids\\The Insectoids.exe', args: ['C:\\app\\services-mcp.mjs'], env: {} },
};
const build = (over: { readOnly?: boolean; servers?: Partial<typeof servers> } = {}) =>
  buildCommandInvocation(QWEN_PRESET, {
    prompt: 'Brief\n\n---\n\nFix it.',
    model: null,
    effort: 'high',
    maxTurns: 30,
    mcpServers: over.servers ?? servers,
    readOnly: over.readOnly ?? false,
    runDir,
    platform: 'win32',
  });
type Settings = {
  tools: { approvalMode: string; disabled: string[] };
  permissions: { deny: string[]; allow: string[] };
  mcp: { allowed: string[] };
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string>; cwd?: string; trust: boolean }>;
  disableAllHooks: boolean;
  privacy: { usageStatisticsEnabled: boolean };
  telemetry: { enabled: boolean };
};
const settingsOf = (inv: ReturnType<typeof build>): Settings => {
  expect(inv.files.map((f) => f.path)).toEqual([QWEN_SETTINGS_FILE]);
  return JSON.parse(inv.files[0]!.content) as Settings;
};
const serverNames = (args: string[]): string[] => {
  const i = args.indexOf('--allowed-mcp-server-names');
  const out: string[] = [];
  for (let j = i + 1; j < args.length && !args[j]!.startsWith('-'); j++) out.push(args[j]!);
  return out;
};

describe('the Qwen Code preset (Phase 4 B4)', () => {
  it('is guarded through its per-run settings file, with nothing that approves everything', () => {
    expect(unguardedReason(QWEN_PRESET)).toBeNull();
    expect(QWEN_PRESET.guard).toMatchObject({ wireAlways: true, disableBuiltinTools: [] });
    for (const a of [...QWEN_PRESET.headlessArgs, ...QWEN_PRESET.guard!.disableBuiltinTools]) expect(isForbiddenArg(a, QWEN_PRESET.forbiddenArgs)).toBe(false);
    // The approval mode is always explicit: the settings default `auto` (a model classifier) never applies.
    expect(QWEN_PRESET.headlessArgs.join(' ')).toContain('--approval-mode default');
    for (const f of ['--yolo', '-y', '--approval-mode=yolo', '--approval-mode=auto-edit', '--allowed-tools', '--safe-mode']) expect(isForbiddenArg(f, QWEN_PRESET.forbiddenArgs)).toBe(true);
    expect(QWEN_PRESET.tested).toBe(false);
  });

  it('the command line: prompt on stdin, the settings file in the run folder, no secret on the command line', () => {
    const inv = build();
    expect(inv.stdin).toBe('Brief\n\n---\n\nFix it.');
    const line = inv.args.join(' ');
    expect(line).not.toContain('Fix it');
    expect(line).not.toContain('secret-token');
    expect(line).not.toContain('INSECTOIDS_GUARD');
    expect(inv.args.slice(0, 2)).toEqual(['-p', 'Do the task described above.']);
    expect(line).toContain('--output-format stream-json');
    expect(line).toContain('--max-session-turns 30');
    expect(serverNames(inv.args)).toEqual(['hive', 'brain', 'services']);
    // The guard is in a system settings file inside the run folder; QWEN_HOME (and so the sign-in) is untouched.
    expect(inv.env).toEqual({
      QWEN_CODE_SYSTEM_SETTINGS_PATH: `${runDir}\\${QWEN_SETTINGS_FILE}`,
      QWEN_USAGE_STATISTICS_ENABLED: 'false',
      QWEN_TELEMETRY_ENABLED: 'false',
    });
    expect(Object.keys(inv.env)).not.toContain('QWEN_HOME');

    const s = settingsOf(inv);
    expect(s.tools).toEqual({ approvalMode: 'default', disabled: [...QWEN_BUILTIN_TOOLS] });
    for (const t of ['run_shell_command', 'edit', 'write_file', 'web_fetch', 'web_search', 'task']) expect(s.tools.disabled).toContain(t);
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'WebFetch', 'Read', 'Agent']));
    expect(s.permissions.allow).toEqual(['mcp__hive', 'mcp__brain', 'mcp__services']);
    expect(s.mcp.allowed).toEqual(['hive', 'brain', 'services']);
    expect(s.disableAllHooks).toBe(true);
    expect(s.privacy.usageStatisticsEnabled).toBe(false);
    expect(s.telemetry.enabled).toBe(false);
    // Secrets live in the settings file (written 0600 by the runner), never as trusted servers.
    expect(s.mcpServers['brain']).toEqual({ command: servers.brain.command, args: servers.brain.args, env: servers.brain.env, trust: false });
    expect(s.mcpServers['hive']?.cwd).toBe('C:\\work');
  });

  it('a read-only run gets no hive tools', () => {
    const inv = build({ readOnly: true });
    const s = settingsOf(inv);
    expect(Object.keys(s.mcpServers)).toEqual(['brain', 'services']);
    expect(s.permissions.allow).toEqual(['mcp__brain', 'mcp__services']);
    expect(serverNames(inv.args)).toEqual(['brain', 'services']);
    expect(inv.files[0]!.content).not.toContain('INSECTOIDS_GUARD');
  });

  it('with no servers at all the guard is still written, and no server loads', () => {
    const inv = build({ readOnly: true, servers: {} });
    const s = settingsOf(inv);
    expect(s.mcpServers).toEqual({});
    expect(s.mcp.allowed).toEqual([QWEN_NO_SERVERS]);
    expect(serverNames(inv.args)).toEqual([QWEN_NO_SERVERS]);
    expect(s.tools.disabled).toEqual([...QWEN_BUILTIN_TOOLS]);
  });

  it('refuses to run where an administrator set machine-wide Qwen settings (the guard would replace them)', () => {
    const run = { runDir, platform: 'win32' as const };
    const machine = 'C:\\ProgramData\\qwen-code\\settings.json';
    expect(() => qwenWiring({}, run, (p) => p === machine)).toThrow(/machine-wide Qwen Code settings .* won't run Qwen Code here/);
    expect(qwenWiring({}, run, () => false).files).toHaveLength(1);
  });

  it('refuses values Qwen Code would expand', () => {
    const run = { runDir, platform: 'win32' as const };
    expect(() => qwenWiring({ brain: { command: 'a', args: [], env: { T: 'x$HOME' } } }, run)).toThrow(/brain server's T contains "\$"/);
    expect(() => qwenWiring({ brain: { command: 'a', args: ['%APPDATA%\\x'], env: {} } }, run)).toThrow(/argument 1/);
    expect(() => build({ servers: { hive: { ...servers.hive, cwd: 'C:\\$work' } } })).toThrow(/would expand/);
  });

  it('its environment: no safe mode, and the run’s own settings path wins over the user’s', () => {
    const inv = build();
    const env = buildCommandEnv({ PATH: 'p', QWEN_CODE_SAFE_MODE: '1', QWEN_CODE_SYSTEM_SETTINGS_PATH: 'C:\\elsewhere.json', QWEN_HOME: 'C:\\q' }, QWEN_PRESET, inv.env);
    expect(env['QWEN_CODE_SAFE_MODE']).toBeUndefined();
    expect(env['QWEN_CODE_SYSTEM_SETTINGS_PATH']).toBe(`${runDir}\\${QWEN_SETTINGS_FILE}`);
    // The user's own Qwen folder (with their sign-in) is passed through untouched.
    expect(env['QWEN_HOME']).toBe('C:\\q');
  });

  it('reads Qwen Code’s documented stream-json shapes', () => {
    expect(parseQwenLine('{"type":"system","subtype":"session_start","uuid":"u1","session_id":"s1","model":"qwen3-coder-plus"}')).toEqual([]);
    expect(
      parseQwenLine(
        '{"type":"assistant","uuid":"u2","session_id":"s1","message":{"id":"m1","type":"message","role":"assistant","model":"qwen3-coder-plus","content":[{"type":"text","text":"The capital of France is Paris."}],"usage":{}},"parent_tool_use_id":null}',
      ),
    ).toEqual([
      { kind: 'usage', usage: {}, model: 'qwen3-coder-plus' },
      { kind: 'text', text: 'The capital of France is Paris.' },
    ]);
    expect(parseQwenLine('{"type":"result","subtype":"success","uuid":"u3","session_id":"s1","is_error":false,"duration_ms":1234,"result":"The capital of France is Paris.","usage":{}}')).toEqual([
      { kind: 'final', ok: true, text: 'The capital of France is Paris.', sessionId: 's1' },
    ]);
    const failed = parseQwenLine('{"type":"result","subtype":"error_during_execution","session_id":"s1","is_error":true,"error":{"message":"401 Unauthorized"}}');
    expect(failed[0]).toMatchObject({ kind: 'error', message: '401 Unauthorized', auth: true });
    expect(failed[1]).toMatchObject({ kind: 'final', ok: false, sessionId: 's1' });
    expect(parseQwenLine('{"type":"stream_event","event":{"type":"goal_state"}}')).toEqual([]);
    expect(parseQwenLine('not json')).toEqual([]);
  });

  it('as an engine: guarded with the hive tools, a subscription, untested, and starting off', () => {
    const a = commandAdapter(QWEN_PRESET, { hiveTools: 'hive-tools.mjs', runtime: { command: 'electron.exe' }, runBase: 'C:\\runs', exists: () => true });
    expect(a).toMatchObject({ id: 'qwen', startsOff: true, availableIn: null, capabilities: { guard: 'policy-and-tools', mcp: true, subscription: true, reportsCost: false } });
    expect(a.unavailableReason).toBeUndefined();
  });
});
