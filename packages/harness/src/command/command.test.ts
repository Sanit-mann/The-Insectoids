import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { ClaudeEvent } from '../claude/stream';
import { EngineRegistry } from '../engines/registry';
import { FakeEngine, type EngineRequest } from '../hive/engine';
import { routeCard } from '../hive/router';
import { fakeAdapter } from '../engines/adapters';
import { CONTAINER_MODE, commandAdapter } from './adapter';
import { MAX_PROMPT_ARG, buildCommandInvocation } from './args';
import { checkCommandSignIn, detectCommand, resolveCmdShim } from './detect';
import { CommandEngine } from './engine';
import { fakeCommandPreset, parseFakeCommandLine } from './fake-preset';
import { type CommandPreset, isForbiddenArg, unguardedReason } from './preset';
import { type CommandRunOptions, buildCommandEnv, estimateCommandCost, isInside, runCommand } from './run';

const FAKE = fileURLToPath(new URL('./fake-command.mjs', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'insectoids command '));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const bin = { command: process.execPath, args: [FAKE] };
const servers = {
  hive: { command: 'electron.exe', args: ['hive-tools.mjs'], env: { ELECTRON_RUN_AS_NODE: '1', INSECTOIDS_GUARD: '{"workspace":"w"}' }, cwd: 'w' },
  brain: { command: 'electron.exe', args: ['brain-mcp.mjs'], env: { INSECTOIDS_BRAIN_TOKEN: 't' } },
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Report = Record<string, any>;

let n = 0;
function workspace(): { cwd: string; runDir: string; report: string } {
  const dir = join(tmp, `case-${++n}`);
  const cwd = join(dir, 'work space');
  mkdirSync(cwd, { recursive: true });
  return { cwd, runDir: join(dir, 'runs', 'run-1'), report: join(dir, 'report.json') };
}

function run(over: Partial<CommandRunOptions> & { mode?: string; envExtra?: Record<string, string> } = {}) {
  const w = workspace();
  const events: ClaudeEvent[] = [];
  const { mode, envExtra, ...rest } = over;
  const handle = runCommand({
    preset: fakeCommandPreset(),
    bin,
    cwd: w.cwd,
    prompt: 'Brief\n\n---\n\nWrite hello.txt\nWRITE hello.txt',
    model: 'fake-medium',
    effort: 'medium',
    maxTurns: 10,
    mcpServers: servers,
    readOnly: false,
    runDir: w.runDir,
    env: { ...process.env, FAKE_COMMAND_REPORT: w.report, FAKE_COMMAND_MODE: mode ?? 'ok', FAKE_SECRET: 'nope', INSECTOIDS_GUARD: 'leak', ...envExtra },
    onEvent: (e) => events.push(e),
    ...rest,
  });
  const report = (): Report => JSON.parse(readFileSync(w.report, 'utf8')) as Report;
  return { ...w, handle, events, report };
}

describe('the command line (Phase 4 B1)', () => {
  const p = fakeCommandPreset();
  const base = { prompt: 'Brief\n\n---\n\nTask', model: 'fake-large', effort: 'high' as const, maxTurns: 12, mcpServers: servers, readOnly: false, runDir: join(tmp, 'r') };

  it('headless flags, built-in tools off, MCP wiring, model, effort and turns; the prompt on stdin', () => {
    const inv = buildCommandInvocation(p, base);
    expect(inv.args).toEqual([
      'run', '--json', '--no-builtin-tools',
      '--mcp-config', join(tmp, 'r', 'mcp.json'), '--only-mcp', 'hive,brain',
      '--model', 'fake-large', '--effort', 'high', '--max-turns', '12',
    ]);
    expect(inv.stdin).toBe(base.prompt);
    expect(inv.env).toEqual({ FAKE_COMMAND_MCP: '1' });
    expect(inv.files).toEqual([{ path: 'mcp.json', content: expect.stringContaining('hive-tools.mjs') }]);
  });

  it('an effort level the CLI has no word for passes nothing', () => {
    expect(buildCommandInvocation(p, { ...base, effort: 'max' }).args).not.toContain('--effort');
  });

  it('a read-only run never gets the hive tools, whatever the caller passed', () => {
    const inv = buildCommandInvocation(p, { ...base, readOnly: true });
    expect(inv.args).toContain('brain');
    expect(inv.args.join(' ')).not.toContain('hive,');
    expect(JSON.parse(inv.files[0]!.content).servers).not.toHaveProperty('hive');
  });

  it('refuses forbidden flags anywhere: headless flags, the guard, the wiring, also as --flag=value', () => {
    expect(isForbiddenArg('--yolo', p.forbiddenArgs)).toBe(true);
    expect(isForbiddenArg('--yolo=true', p.forbiddenArgs)).toBe(true);
    expect(isForbiddenArg('--yolon', p.forbiddenArgs)).toBe(false);
    const headless = fakeCommandPreset({ headlessArgs: ['run', '--yolo'] });
    expect(unguardedReason(headless)).toMatch(/--yolo/);
    expect(() => buildCommandInvocation(headless, base)).toThrow(/--yolo/);
    const wiring = fakeCommandPreset({ guard: { disableBuiltinTools: ['--no-builtin-tools'], wireMcp: () => ({ args: ['--allow-all-tools=1'] }) } });
    expect(() => buildCommandInvocation(wiring, base)).toThrow(/Refusing "--allow-all-tools=1"/);
  });

  it('refuses an unguarded preset, one with no tool switch, and full work for a CLI that can’t load MCP', () => {
    expect(() => buildCommandInvocation(fakeCommandPreset({ guard: null }), base)).toThrow(/container/);
    expect(() => buildCommandInvocation(fakeCommandPreset({ guard: { disableBuiltinTools: [], wireMcp: null } }), base)).toThrow(/switch off its own tools/);
    const noMcp = fakeCommandPreset({ guard: { disableBuiltinTools: ['--no-builtin-tools'], wireMcp: null } });
    expect(() => buildCommandInvocation(noMcp, base)).toThrow(/read-only/);
    expect(buildCommandInvocation(noMcp, { ...base, readOnly: true }).files).toEqual([]);
  });

  it('a guard that lives in a per-run config is written on every run, also with no servers (Phase 4 B4)', () => {
    const configGuard = fakeCommandPreset({
      guard: {
        disableBuiltinTools: [],
        wireAlways: true,
        wireMcp: (servers) => ({ env: { FAKE_HOME: 'run' }, files: [{ path: 'home/settings.json', content: JSON.stringify({ deny: ['shell', 'write'], servers: Object.keys(servers) }) }] }),
      },
    });
    expect(unguardedReason(configGuard)).toBeNull();
    const inv = buildCommandInvocation(configGuard, { ...base, readOnly: true, mcpServers: {} });
    expect(inv.files).toEqual([{ path: join('home', 'settings.json'), content: '{"deny":["shell","write"],"servers":[]}' }]);
    expect(inv.env).toEqual({ FAKE_HOME: 'run' });
    // Without wireAlways, an empty tool switch still means unguarded.
    expect(unguardedReason(fakeCommandPreset({ guard: { disableBuiltinTools: [], wireMcp: configGuard.guard!.wireMcp } }))).toMatch(/switch off its own tools/);
  });

  it('an unguarded preset can say why, after the plain reason', () => {
    expect(unguardedReason(fakeCommandPreset({ guard: null, unguardedWhy: 'Its print mode edits files on its own.' }))).toBe(
      "Fake command can't be guarded yet; it will run inside a container once container mode exists. Its print mode edits files on its own.",
    );
  });

  it('values that would read as flags, and wiring files that leave the run folder, are refused', () => {
    expect(() => buildCommandInvocation(p, { ...base, model: '--yolo' })).toThrow(/starts with "-"/);
    const positional = fakeCommandPreset({ prompt: { via: 'arg', flag: null } });
    expect(() => buildCommandInvocation(positional, { ...base, prompt: '--dangerous' })).toThrow(/read it as a flag/);
    const escape = fakeCommandPreset({ guard: { disableBuiltinTools: ['--x'], wireMcp: () => ({ files: [{ path: '../evil.json', content: '{}' }] }) } });
    expect(() => buildCommandInvocation(escape, base)).toThrow(/outside the run folder/);
  });

  it('a prompt too long for a command line is refused in argument mode, fine on stdin or in a file', () => {
    const long = 'x'.repeat(MAX_PROMPT_ARG + 1);
    expect(() => buildCommandInvocation(fakeCommandPreset({ prompt: { via: 'arg', flag: '-p' } }), { ...base, prompt: long })).toThrow(/too long/);
    expect(buildCommandInvocation(fakeCommandPreset({ prompt: { via: 'file', flag: '--prompt-file' } }), { ...base, prompt: long }).files.at(-1)).toEqual({ path: 'prompt.md', content: long });
  });

  it('the CLI’s environment loses the hive’s secrets and what the preset names', () => {
    const env = buildCommandEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', insectoids_guard: 'x', INSECTOIDS_BROKER_TOKEN: 't', FAKE_SECRET: 's', KEEP: 'k' }, p, { FAKE_COMMAND_MCP: '1' });
    expect(env).toEqual({ PATH: '/bin', KEEP: 'k', FAKE_COMMAND_MCP: '1' });
  });

  it('paths inside the workspace are caught, also with different case on Windows', () => {
    expect(isInside('C:\\W\\a\\b', 'c:\\w', 'win32')).toBe(true);
    expect(isInside(join(tmp, 'runs'), join(tmp, 'work'))).toBe(false);
  });
});

describe('a run on the stand-in CLI', () => {
  it('passes the prompt on stdin, writes the MCP wiring outside the workspace, then removes it', async () => {
    const r = run();
    const result = await r.handle.done;
    expect(result).toMatchObject({ ok: true, text: 'Working on it.\nDone.\nSTATUS: DONE', sessionId: 's-1', numTurns: 2, exitCode: 0 });
    const rep = r.report();
    expect(rep['how']).toBe('stdin');
    expect(rep['prompt']).toContain('Write hello.txt');
    expect(rep['cwd'].toLowerCase()).toBe(r.cwd.toLowerCase());
    expect(rep['mcpPath']).toBe(join(r.runDir, 'mcp.json'));
    expect(isInside(rep['mcpPath'], r.cwd)).toBe(false);
    expect(Object.keys(rep['mcp'].servers)).toEqual(['hive', 'brain']);
    expect(rep['args']).toEqual(expect.arrayContaining(['--no-builtin-tools', '--model', 'fake-medium', '--effort', 'medium', '--max-turns', '10']));
    // The wiring's env reached the CLI; the hive's own variables and the preset's scrubbed ones didn't.
    expect(rep['env']).toEqual({ FAKE_COMMAND_MCP: '1', ELECTRON_RUN_AS_NODE: null, INSECTOIDS_GUARD: null, INSECTOIDS_BRAIN_TOKEN: null, FAKE_SECRET: null });
    expect(existsSync(r.runDir)).toBe(false);
    expect(readdirSync(r.cwd)).toEqual(['hello.txt']);
  });

  it('reads JSON lines into text, tool and result events; usage, model and an estimated cost', async () => {
    const r = run();
    const result = await r.handle.done;
    expect(result.usage).toEqual({ input: 3000, output: 500, cacheRead: 1000, cacheWrite: 0 });
    expect(result.models).toEqual(['fake-medium-2026']);
    expect(result.model).toBe('fake-medium-2026');
    expect(result.costEstimated).toBe(true);
    expect(result.costUsd).toBe(estimateCommandCost(fakeCommandPreset(), result.usage));
    expect(result.costUsd).toBeCloseTo((3000 * 1 + 500 * 4) / 1e6, 9);
    expect(r.events.map((e) => e.kind)).toEqual(['init', 'text', 'tool_use', 'text', 'result']);
    expect(r.events[2]).toMatchObject({ kind: 'tool_use', name: 'hive_write_file', input: { path: 'hello.txt' } });
    expect(r.events.at(-1)).toMatchObject({ kind: 'result', isError: false, models: ['fake-medium-2026'], usage: result.usage });
  });

  it('a cost the CLI reports wins when the preset says it reports cost', async () => {
    const r = run({ preset: fakeCommandPreset({ reportsCost: true }), envExtra: { FAKE_COMMAND_COST: '0.0123' } });
    expect(await r.handle.done).toMatchObject({ ok: true, costUsd: 0.0123, costEstimated: false });
  });

  it('passes the prompt as a flag argument, as the last argument, or in a file in the run folder', async () => {
    const prompt = 'Brief\n\n---\n\nSay "hi" & stop; 100% done\nWRITE a.txt';
    const viaArg = run({ preset: fakeCommandPreset({ prompt: { via: 'arg', flag: '-p' } }), prompt });
    await viaArg.handle.done;
    expect(viaArg.report()).toMatchObject({ how: 'arg', prompt });
    const positional = run({ preset: fakeCommandPreset({ prompt: { via: 'arg', flag: null }, headlessArgs: ['run', '--json', '--prompt-last'] }), prompt });
    await positional.handle.done;
    expect(positional.report()).toMatchObject({ how: 'positional', prompt });
    const viaFile = run({ preset: fakeCommandPreset({ prompt: { via: 'file', flag: '--prompt-file' } }), prompt });
    expect((await viaFile.handle.done).ok).toBe(true);
    const rep = viaFile.report();
    expect(rep).toMatchObject({ how: 'file', prompt });
    expect(rep['args']).toContain(join(viaFile.runDir, 'prompt.md'));
    expect(existsSync(viaFile.runDir)).toBe(false);
  });

  it('the stand-in refuses to write outside its workspace, and the run says so', async () => {
    const r = run({ prompt: 'Brief\n\n---\n\nWRITE ../outside.txt' });
    const result = await r.handle.done;
    expect(existsSync(join(r.cwd, '..', 'outside.txt'))).toBe(false);
    expect(r.events).toContainEqual({ kind: 'text', text: 'Fake command error: Refused to write outside the workspace: ../outside.txt' });
    expect(result.stderrTail).toMatch(/Refused to write outside/);
  });

  it('plain-text output becomes the run’s text', async () => {
    const r = run({ preset: fakeCommandPreset({ output: { format: 'text' } }), mode: 'text' });
    const result = await r.handle.done;
    expect(result).toMatchObject({ ok: true, text: 'Working on it.\nDone.\nSTATUS: DONE', costUsd: 0, costEstimated: true });
    expect(result.models).toEqual(['fake-medium']);
  });

  it('maps a signed-out exit, a usage limit, a model failure and garbage output to plain errors', async () => {
    const auth = await run({ mode: 'auth' }).handle.done;
    expect(auth).toMatchObject({ ok: false, error: 'auth', exitCode: 41 });
    expect(auth.stderrTail).toMatch(/not signed in/);
    expect(await run({ mode: 'quota' }).handle.done).toMatchObject({ ok: false, error: 'quota' });
    expect(await run({ mode: 'fail' }).handle.done).toMatchObject({ ok: false, error: 'model-error', stderrTail: expect.stringMatching(/gave up/) });
    const garbage = await run({ mode: 'garbage' }).handle.done;
    expect(garbage).toMatchObject({ ok: false, error: 'crash' });
    expect(garbage.stderrTail).toMatch(/stopped with exit code 1/);
  });

  it('a timeout and a stop end the process and still remove the run folder', async () => {
    const t = run({ mode: 'hang', timeoutMs: 1500 });
    const timedOut = await t.handle.done;
    expect(timedOut).toMatchObject({ ok: false, error: 'timeout' });
    expect(timedOut.stderrTail).toMatch(/time limit/);
    expect(existsSync(t.runDir)).toBe(false);
    const s = run({ mode: 'hang' });
    setTimeout(() => s.handle.stop(), 1000);
    expect(await s.handle.done).toMatchObject({ ok: false, error: 'stopped' });
    expect(existsSync(s.runDir)).toBe(false);
  });

  it('refuses a run folder inside the workspace, and a program that isn’t there fails in plain words', async () => {
    const w = workspace();
    const inside = await runCommand({ preset: fakeCommandPreset(), bin, cwd: w.cwd, prompt: 'x', model: null, mcpServers: {}, readOnly: true, runDir: join(w.cwd, '.run') }).done;
    expect(inside).toMatchObject({ ok: false, error: 'crash', stderrTail: expect.stringMatching(/outside the workspace/) });
    const missing = await runCommand({ preset: fakeCommandPreset(), bin: { command: join(tmp, 'no-such-program.exe'), args: [] }, cwd: w.cwd, prompt: 'x', model: null, mcpServers: {}, readOnly: true, runDir: w.runDir }).done;
    expect(missing).toMatchObject({ ok: false, error: 'crash', stderrTail: expect.stringMatching(/Could not start Fake command/) });
    expect(existsSync(w.runDir)).toBe(false);
  });

  it('parses nothing from malformed lines', () => {
    expect(parseFakeCommandLine('not json')).toEqual([]);
    expect(parseFakeCommandLine('{"type":"unknown"}')).toEqual([]);
  });
});

const req = (role: EngineRequest['role'], cwd: string): EngineRequest => ({
  role,
  agentId: 'Ant-01',
  cwd,
  system: 'Brief',
  task: 'Do it',
  route: { engine: 'custom', tier: 'standard', model: 'fake-medium', effort: 'medium', reason: 'rule: test', maxTurns: 10, maxBudgetUsd: 1, timeoutMs: 20_000 },
  guard: { workspace: cwd, home: cwd, noGo: [], network: 'none' },
  brain: { endpoint: 'http://127.0.0.1:1/brain', token: 'brain-token', doors: { runtime: { command: 'electron.exe' }, mcpScript: 'brain-mcp.mjs', cliShimDir: null } } as unknown as NonNullable<EngineRequest['brain']>,
});

describe('the command engine', () => {
  const runtime = { command: 'electron.exe', args: ['--x'], env: { ELECTRON_RUN_AS_NODE: '1' } };

  it('loads the guarded hive tools with the card’s guard policy, the Brain door, and the prompt with the brief first', async () => {
    const seen: CommandRunOptions[] = [];
    const engine = new CommandEngine({
      preset: fakeCommandPreset(),
      bin,
      hiveTools: 'hive-tools.mjs',
      runtime,
      runBase: join(tmp, 'engine-runs'),
      run: (o) => {
        seen.push(o);
        return { done: Promise.resolve({ ok: true, model: null, models: [], sessionId: null, text: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, numTurns: 0, durationMs: 0, exitCode: 0, stderrTail: '' }), stop: () => {} };
      },
    });
    const w = workspace();
    await engine.run(req('coder', w.cwd)).done;
    const o = seen[0]!;
    expect(o.prompt).toBe('Brief\n\n---\n\nDo it');
    expect(o.readOnly).toBe(false);
    expect(o.model).toBe('fake-medium');
    expect(o.mcpServers.hive).toMatchObject({ command: 'electron.exe', args: ['--x', 'hive-tools.mjs'], cwd: w.cwd, env: { ELECTRON_RUN_AS_NODE: '1' } });
    expect(JSON.parse(o.mcpServers.hive!.env['INSECTOIDS_GUARD']!)).toMatchObject({ workspace: w.cwd, network: 'none' });
    expect(o.mcpServers.brain).toMatchObject({ args: ['--x', 'brain-mcp.mjs'], env: { INSECTOIDS_BRAIN_TOKEN: 'brain-token' } });
    expect(isInside(o.runDir, w.cwd)).toBe(false);
    expect(o.runDir.startsWith(join(tmp, 'engine-runs'))).toBe(true);
  });

  it('without the hive tools, or for a CLI that can’t load MCP, only read-only work, and never the hive tools', async () => {
    const noTools = new CommandEngine({ preset: fakeCommandPreset(), bin, hiveTools: null, runtime, runBase: join(tmp, 'engine-runs') });
    expect(await noTools.run(req('coder', tmp)).done).toMatchObject({ ok: false, stderrTail: expect.stringMatching(/read-only work here/) });
    const noMcp = new CommandEngine({ preset: fakeCommandPreset({ guard: { disableBuiltinTools: ['--no-builtin-tools'], wireMcp: null } }), bin, hiveTools: 'hive-tools.mjs', runtime, runBase: join(tmp, 'engine-runs') });
    expect(await noMcp.run(req('coder', tmp)).done).toMatchObject({ ok: false, stderrTail: expect.stringMatching(/can't load the hive tools/) });
    const unguarded = new CommandEngine({ preset: fakeCommandPreset({ guard: null }), bin, hiveTools: 'hive-tools.mjs', runtime, runBase: join(tmp, 'engine-runs') });
    expect(await unguarded.run(req('reviewer', tmp)).done).toMatchObject({ ok: false, stderrTail: expect.stringMatching(/container/) });
  });

  it('runs a card end to end on the stand-in CLI', async () => {
    const w = workspace();
    const engine = new CommandEngine({ preset: fakeCommandPreset(), bin, hiveTools: 'hive-tools.mjs', runtime, runBase: join(w.runDir, '..') });
    const r = engine.run({ ...req('coder', w.cwd), task: 'WRITE out.txt' });
    expect(await r.done).toMatchObject({ ok: true, text: 'Working on it.\nDone.\nSTATUS: DONE' });
    expect(readFileSync(join(w.cwd, 'out.txt'), 'utf8')).toBe('hi');
    expect(readdirSync(join(w.runDir, '..'))).toEqual([]);
  });
});

describe('detection', () => {
  const p = fakeCommandPreset();
  const winEnv = { PATH: 'C:\\tools;C:\\npm' };
  const deps = (files: Record<string, string>, out: Record<string, string>) => ({
    exists: (f: string) => f in files,
    readFile: (f: string) => files[f] ?? '',
    run: async (command: string, args: readonly string[]) => {
      const key = `${command} ${args.join(' ')}`;
      if (!(key in out)) throw new Error(`not found: ${key}`);
      return out[key]!;
    },
    env: winEnv,
    platform: 'win32' as const,
  });

  it('missing, outdated, unreadable version, and ready (a real .exe on PATH, no shell)', async () => {
    expect(await detectCommand(p, deps({}, {}))).toEqual({ status: 'missing' });
    const exe = join('C:\\npm', 'fake-command.exe');
    expect(await detectCommand(p, deps({ [exe]: '' }, { [`${exe} --version`]: 'fake-command 1.1.9' }))).toEqual({ status: 'outdated', command: exe, version: '1.1.9', minimum: '1.2.0' });
    expect(await detectCommand(p, deps({ [exe]: '' }, { [`${exe} --version`]: 'hello' }))).toMatchObject({ status: 'unsupported', reason: expect.stringMatching(/couldn't read its version/) });
    expect(await detectCommand(p, deps({ [exe]: '' }, { [`${exe} --version`]: 'fake-command 1.4.2' }))).toEqual({ status: 'installed', command: exe, args: [], version: '1.4.2' });
  });

  it('reads an npm .cmd launcher to start its target directly (Node + script, or the .exe), never the launcher', async () => {
    const shim = join('C:\\npm', 'fake-command.cmd');
    const script = join('C:\\npm', 'node_modules\\fake-command\\cli.js');
    const node = join('C:\\npm', 'node.exe');
    const text = '@ECHO off\r\nGOTO start\r\n:start\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-command\\cli.js" %*\r\n';
    const d = deps({ [shim]: text, [script]: '', [node]: '' }, { [`${node} ${script} --version`]: 'fake-command 1.4.2' });
    expect(await detectCommand(p, d)).toEqual({ status: 'installed', command: node, args: [script], version: '1.4.2' });
    const exe = join('C:\\npm', 'node_modules\\fake\\bin\\fake.exe');
    expect(resolveCmdShim('"%dp0%\\node_modules\\fake\\bin\\fake.exe"   %*', 'C:\\npm', { exists: (f) => f === exe, env: winEnv, platform: 'win32' })).toEqual({ command: exe, args: [] });
    expect(await detectCommand(p, deps({ [shim]: '@echo off\r\npowershell -c something %*' }, {}))).toMatchObject({ status: 'unsupported', reason: expect.stringMatching(/never starts programs through a shell/) });
  });

  it('the signed-in check runs the CLI’s own status command; with no check the hive can’t tell', async () => {
    const real = { command: process.execPath, args: [FAKE] };
    expect(await checkCommandSignIn(p, real)).toBe(true);
    const run = async (_c: string, _a: readonly string[]) => 'Not logged in.';
    expect(await checkCommandSignIn(p, real, { run })).toBe(false);
    expect(await checkCommandSignIn((({ signedInCheck: _drop, ...rest }) => rest as CommandPreset)(fakeCommandPreset()), real)).toBeNull();
  });
});

describe('the adapter and the router', () => {
  const o = { hiveTools: 'hive-tools.mjs', runtime: { command: 'electron.exe' }, runBase: join(tmp, 'adapter-runs'), exists: () => true };
  const installed = async () => ({ status: 'installed' as const, command: process.execPath, args: [FAKE], version: '1.4.2' });

  it('detection states in plain words: missing, outdated, signed out, ready (and untested says so)', async () => {
    const p = fakeCommandPreset();
    expect(await commandAdapter(p, { ...o, detect: async () => ({ status: 'missing' }) }).detect!()).toMatchObject({ state: 'missing', message: expect.stringMatching(/not installed/) });
    expect(await commandAdapter(p, { ...o, detect: async () => ({ status: 'outdated', command: 'x', version: '1.0.0', minimum: '1.2.0' }) }).detect!()).toMatchObject({
      state: 'outdated',
      message: 'Fake command 1.0.0 is older than 1.2.0, the oldest the hive runs. Update it.',
    });
    expect(await commandAdapter(p, { ...o, detect: installed, signedIn: async () => false }).detect!()).toMatchObject({ state: 'signed-out', message: expect.stringMatching(/Run "fake-command login"/) });
    const ready = commandAdapter(p, { ...o, detect: installed, signedIn: async () => true });
    expect(await ready.detect!()).toEqual({ state: 'ready', version: '1.4.2', message: 'Fake command 1.4.2 is ready.' });
    expect(ready.capabilities).toMatchObject({ guard: 'policy-and-tools', mcp: true, free: false, reportsCost: false, effort: ['low', 'medium', 'high'] });
    expect(ready.create!()).toBeInstanceOf(CommandEngine);
    const untested = commandAdapter(fakeCommandPreset({ tested: false }), { ...o, detect: installed, signedIn: async () => null });
    expect((await untested.detect!()).message).toMatch(/can’t check its sign-in.*hasn’t been checked against the real program/);
  });

  it('a guarded preset without the hive tools is read-only', () => {
    expect(commandAdapter(fakeCommandPreset(), { ...o, exists: () => false }).capabilities.guard).toBe('read-only');
  });

  it('an unguarded preset is listed with its reason, never detected or run', () => {
    const a = commandAdapter(fakeCommandPreset({ guard: null, name: 'Grok CLI', id: 'grok' }), o);
    expect(a.capabilities.guard).toBeNull();
    expect(a.availableIn).toBe(CONTAINER_MODE);
    expect(a.detect).toBeUndefined();
    expect(a.create).toBeUndefined();
    const r = new EngineRegistry([a]);
    expect(r.cards()[0]).toMatchObject({
      id: 'grok',
      state: 'unsupported',
      guard: null,
      availableIn: CONTAINER_MODE,
      message: "Grok CLI can't be guarded yet; it will run inside a container once container mode exists.",
    });
  });

  it('the router never sends work to an unguarded preset, even first in the order and claiming to be ready', async () => {
    const unguarded = commandAdapter(fakeCommandPreset({ guard: null, id: 'grok' }), o);
    // Even if something gave it a detection and a runner, its guard stays null.
    const forced = { ...unguarded, detect: async () => ({ state: 'ready' as const, version: '1', message: 'ready' }), create: () => new FakeEngine(() => ({ text: 'x' })) };
    const r = new EngineRegistry([forced, fakeAdapter(new FakeEngine(() => ({ text: 'STATUS: DONE' })))]);
    await r.detectAll();
    expect(r.isReady('grok')).toBe(true);
    for (const role of ['coder', 'reviewer', 'queen'] as const) {
      expect(r.route({ role, priority: 'normal', attempts: 0 }, routeCard).engine).toBe('fake');
    }
    const alone = new EngineRegistry([forced]);
    await alone.detectAll();
    expect(alone.canRoute('reviewer')).toBe(false);
    expect(alone.canRoute('coder')).toBe(false);
  });
});
