import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { BRAIN_ENV, type BrainService, startBrainService } from '@insectoids/brain-service';
import { rolldown } from 'rolldown';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SHIM_ARGS_ENV, cmdShim, cmdShimArgs, posixShim, splitWindowsArgs, writeBrainShims } from './shims';

const isWin = process.platform === 'win32';
const startedAt = Date.now() - 1000;
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

describe('splitting a Windows command line (C runtime rules)', () => {
  it.each([
    ['a b  c', ['a', 'b', 'c']],
    ['"a b" c', ['a b', 'c']],
    ['a"b c"d', ['ab cd']],
    ['""', ['']],
    ['"say ""hi"""', ['say "hi"']],
    ['\\"quoted\\"', ['"quoted"']],
    ['"C:\\dir with space\\\\" next', ['C:\\dir with space\\', 'next']],
    ['a\\\\\\"b', ['a\\"b']],
    ['C:\\path\\file.txt', ['C:\\path\\file.txt']],
    ['  ', []],
    ['a&b "x | y" ^<', ['a&b', 'x | y', '^<']],
  ])('%j', (line, args) => {
    expect(splitWindowsArgs(line)).toEqual(args);
  });

  it('reads the echoed rem line brain.cmd captures', () => {
    expect(cmdShimArgs({})).toBeUndefined();
    expect(cmdShimArgs({ [SHIM_ARGS_ENV]: 'D:\\work dir>rem @@@search "a & b" x|y@@@ ' })).toEqual(['search', 'a & b', 'x|y']);
    expect(cmdShimArgs({ [SHIM_ARGS_ENV]: 'C:\\>rem @@@@@@ ' })).toEqual([]);
    expect(cmdShimArgs({ [SHIM_ARGS_ENV]: 'C:\\>rem @@@--title "a@@@b"@@@ ' })).toEqual(['--title', 'a@@@b']);
    expect(cmdShimArgs({ [SHIM_ARGS_ENV]: '' })).toEqual([]);
  });
});

describe('shim text', () => {
  const target = { command: 'C:\\Program Files\\The Insectoids\\Insectoids.exe', args: ['C:\\app 100%\\brain.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } };

  it('POSIX: single-quoted, forwards "$@", no Git Bash path conversion, no stale capture', () => {
    const sh = posixShim({ command: "/opt/it's here/node", args: ['/x/brain.mjs'], env: { A: "v'1" } });
    expect(sh).toContain(`exec '/opt/it'\\''s here/node' '/x/brain.mjs' "$@"`);
    expect(sh).toContain(`A='v'\\''1'\nexport A`);
    expect(sh).toContain('MSYS_NO_PATHCONV=1');
    expect(sh).toContain(`unset ${SHIM_ARGS_ENV}`);
    expect(posixShim(target)).toContain(`exec 'C:/Program Files/The Insectoids/Insectoids.exe' 'C:/app 100%/brain.mjs' "$@"`);
  });

  it('cmd: CRLF, arguments never on an executed line, % doubled in paths', () => {
    const cmd = cmdShim(target);
    expect(cmd).toContain('\r\n');
    expect(cmd).toContain('set "BRAIN_A0=C:\\app 100%%\\brain.mjs"');
    expect(cmd).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    const withArgs = cmd.split('\r\n').filter((l) => l.includes('%*'));
    expect(withArgs).toEqual(['  for %%. in (.) do rem @@@%*@@@']);
  });

  it('refuses quotes, newlines and bad variable names', () => {
    expect(() => cmdShim({ command: 'C:\\a"b.exe', args: [] })).toThrow(/quote/);
    expect(() => posixShim({ command: '/x', args: ['a\nb'] })).toThrow(/newline/);
    expect(() => cmdShim({ command: '/x', args: [], env: { 'A B': '1' } })).toThrow(/name/);
  });
});

// ---- the real thing: bundled CLI, real shims, real shell, path with a space --------------------

let tmp: string;
let work: string;
let shims: { posix: string; cmd: string };
let brain: Brain;
let service: BrainService;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'insectoids brain cli '));
  const binDir = join(tmp, 'app 100%!dir');
  mkdirSync(binDir);
  const bundlePath = join(binDir, 'brain.mjs');
  const bundle = await rolldown({ input: here('./bin/brain.ts'), platform: 'node' });
  await bundle.write({ file: bundlePath, format: 'esm' });
  await bundle.close();
  shims = writeBrainShims(join(tmp, 'shim bin'), { command: process.execPath, args: [bundlePath], env: { ELECTRON_RUN_AS_NODE: '1' } });
  work = join(tmp, 'work dir');
  mkdirSync(work);
  brain = openBrain(':memory:');
  service = await startBrainService({ brain });
  env = {
    ...process.env,
    [BRAIN_ENV.endpoint]: service.endpoint,
    [BRAIN_ENV.token]: service.issueAgentToken({ agentId: 'Ant-shim', shelf: 'site', write: true }),
  };
}, 60_000);

afterAll(async () => {
  await service?.close();
  brain?.close();
  rmSync(tmp, { recursive: true, force: true });
});

interface Ran {
  code: number | null;
  out: string;
  err: string;
}

/** Async on purpose: the service answers from this same process. */
function exec(file: string, args: string[], stdin: string | undefined, verbatim = false): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: work, env, windowsVerbatimArguments: verbatim });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(stdin ?? '');
  });
}

/** Run brain.cmd as `cmd /d /s /c ""<shim>" <rawArgs>"`, which is how cmd and PowerShell start a batch file. */
const viaCmd = (rawArgs: string, stdin?: string) => exec('cmd.exe', ['/d', '/s', '/c', `""${shims.cmd}" ${rawArgs}"`], stdin, true);

const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find((p) => existsSync(p));
const viaSh = (args: string[], stdin?: string) =>
  isWin ? exec(gitBash!, [shims.posix.replace(/\\/g, '/'), ...args], stdin) : exec(shims.posix, args, stdin);

describe.runIf(isWin)('brain.cmd through cmd.exe', () => {
  it('writes with a stdin body and finds it again', async () => {
    const w = await viaCmd('write --kind fact --title "Hosting plan" --body -', 'We host on Vercel.\r\n');
    expect(w.err).toBe('');
    expect(w).toMatchObject({ code: 0 });
    const id = /^created (\S+)/.exec(w.out)?.[1];
    expect(brain.get(id!)).toMatchObject({ title: 'Hosting plan', body: 'We host on Vercel.', owner: 'Ant-shim' });
    expect((await viaCmd('search hosting')).out).toContain(`${id} [fact] Hosting plan`);
  });

  it('cmd metacharacters in arguments stay text, never commands', async () => {
    const title = 'R&D | <beta> 100% ^caret !bang (v2)';
    const w = await viaCmd(`write --kind fact --title "${title} & echo INJECTED" --body "a & b"`);
    expect(w.code).toBe(0);
    const id = /^created (\S+)/.exec(w.out)![1]!;
    expect(brain.get(id)).toMatchObject({ title: `${title} & echo INJECTED`, body: 'a & b' });
    expect(w.out + w.err).not.toMatch(/^INJECTED/m);

    // An escaped metacharacter outside quotes reaches the shim as a bare & (the classic batch-file hole).
    const s = await viaCmd('search R^&D^|x ^& echo INJECTED2');
    expect(s.code).toBe(0);
    expect(s.out + s.err).not.toMatch(/^INJECTED2/m);
  });

  it('passes the exit code through (usage error = 2, refusal = 1)', async () => {
    expect((await viaCmd('search')).code).toBe(2);
    expect((await viaCmd('get nope')).code).toBe(1);
  });

  it('cleans up its capture file', () => {
    // Nothing named insectoids-brain-*.txt may linger in %TEMP% from this test run's shim calls.
    const left = readdirSync(tmpdir()).filter((f) => /^insectoids-brain-\d+\.txt$/.test(f) && statSync(join(tmpdir(), f)).mtimeMs > startedAt);
    expect(left).toEqual([]);
  });
});

describe.runIf(!isWin || gitBash)('brain POSIX script (sh, or Git Bash on Windows)', () => {
  it('writes with a stdin body and finds it again; arguments arrive exactly', async () => {
    const w = await viaSh(['write', '--kind', 'fact', '--title', '/hero & "quotes" $HOME', '--body', '-'], 'From sh.\n');
    expect(w.err).toBe('');
    expect(w.code).toBe(0);
    const id = /^created (\S+)/.exec(w.out)![1]!;
    expect(brain.get(id)).toMatchObject({ title: '/hero & "quotes" $HOME', body: 'From sh.' });
    expect((await viaSh(['search', 'hero', '--json'])).out).toContain(id);
    expect((await viaSh(['get', 'missing'])).code).toBe(1);
  });

  it('is executable', () => {
    if (!isWin) expect(statSync(shims.posix).mode & 0o111).not.toBe(0);
    expect(readFileSync(shims.posix, 'utf8').startsWith('#!/bin/sh\n')).toBe(true);
  });
});

