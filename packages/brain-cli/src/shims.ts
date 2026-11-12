import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ShimTarget {
  /** Program to run, e.g. the Electron binary (with ELECTRON_RUN_AS_NODE=1) or node. */
  command: string;
  /** Leading arguments, e.g. [path/to/brain.mjs]. User arguments follow them. */
  args: string[];
  /** Extra environment for the launched program, e.g. { ELECTRON_RUN_AS_NODE: '1' }. */
  env?: Record<string, string>;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Marks the start and end of the raw arguments in brain.cmd's echoed rem line. */
const MARK = '@@@';
/** Variable through which brain.cmd hands the captured argument line to the program. */
export const SHIM_ARGS_ENV = 'BRAIN_SHIM_ARGS';

function check(target: ShimTarget): void {
  for (const [k, val] of Object.entries(target.env ?? {})) {
    if (!ENV_NAME.test(k)) throw new Error(`Invalid environment variable name for the brain shim: ${k}`);
    if (/["\r\n\0]/.test(val)) throw new Error(`Environment value for ${k} contains a quote or newline.`);
  }
  for (const p of [target.command, ...target.args]) {
    // A double quote cannot be escaped inside a cmd.exe quoted string; newlines would end the line.
    if (/["\r\n\0]/.test(p)) throw new Error(`Shim path contains a quote or newline: ${p}`);
  }
}

/** POSIX sh single-quoting: everything literal; ' becomes '\''. */
const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/** Git Bash on Windows runs this script too; it wants C:/x/y rather than C:\x\y. */
const forSh = (p: string): string => (/^[A-Za-z]:\\/.test(p) ? p.replace(/\\/g, '/') : p);
/** In a batch file % starts a variable even inside quotes; %% is a literal %. */
const pct = (s: string): string => s.replace(/%/g, '%%');

/**
 * POSIX `brain` script (also what Git Bash on Windows runs: Claude Code's Bash tool there is Git Bash).
 * "$@" forwards every argument exactly; nothing is re-parsed. Git Bash's automatic path conversion is
 * switched off so arguments like "/hero" reach the program unchanged.
 */
export function posixShim(target: ShimTarget): string {
  check(target);
  const env = Object.entries(target.env ?? {}).map(([k, val]) => `${k}=${sq(val)}\nexport ${k}\n`).join('');
  return [
    '#!/bin/sh',
    '# The Insectoids: `brain` command shim (generated; do not edit).',
    'MSYS_NO_PATHCONV=1',
    "MSYS2_ARG_CONV_EXCL='*'",
    'export MSYS_NO_PATHCONV MSYS2_ARG_CONV_EXCL',
    `unset ${SHIM_ARGS_ENV}`,
    `${env}exec ${[target.command, ...target.args].map((p) => sq(forSh(p))).join(' ')} "$@"`,
    '',
  ].join('\n');
}

/**
 * Windows `brain.cmd` (what PowerShell and cmd.exe find through PATHEXT).
 *
 * Batch files re-parse their arguments ("BatBadBut"): `prog %*` turns a caret-escaped `a^&b` into a
 * live `&`, and `set "X=%*"` breaks on a quoted `"a & b"`. So the arguments never appear on a line cmd
 * executes. The shim echoes them inside a `rem` (which cmd never runs) with `echo on`, reads that
 * echoed line back with `for /f` (its %%L expands after the line is parsed, so the text is never cmd
 * syntax) into BRAIN_SHIM_ARGS, and the program splits that raw text itself with the standard Windows
 * argv rules. The program's path and extra variables are set while delayed expansion is off and used
 * while it is on, so %, ! and ^ in paths stay literal.
 *
 * Limits: the cmd.exe that starts the shim still parses the caller's own command line first (the
 * caller's quoting, which the command guard checks); lines over cmd's 8191 characters are cut; the
 * capture goes through a short-lived file in %TEMP%. Free text is safest on stdin (`--body -`).
 */
export function cmdShim(target: ShimTarget): string {
  check(target);
  const env = Object.entries(target.env ?? {}).map(([k, val]) => `set "${k}=${pct(val)}"`);
  return [
    '@echo off',
    'rem The Insectoids: `brain` command shim (generated; do not edit).',
    'setlocal DisableDelayedExpansion',
    'set "BRAIN_ARGFILE=%TEMP%\\insectoids-brain-%RANDOM%%RANDOM%%RANDOM%.txt"',
    '(',
    '  setlocal',
    '  set "prompt="',
    '  echo on',
    `  for %%. in (.) do rem ${MARK}%*${MARK}`,
    '  @echo off',
    '  endlocal',
    ')> "%BRAIN_ARGFILE%"',
    `set "${SHIM_ARGS_ENV}="`,
    `for /f "usebackq delims=" %%L in ("%BRAIN_ARGFILE%") do set "${SHIM_ARGS_ENV}=%%L"`,
    'del "%BRAIN_ARGFILE%" >nul 2>&1',
    'set "BRAIN_ARGFILE="',
    ...env,
    `set "BRAIN_EXE=${pct(target.command)}"`,
    ...target.args.map((a, i) => `set "BRAIN_A${i}=${pct(a)}"`),
    'setlocal EnableDelayedExpansion',
    ['"!BRAIN_EXE!"', ...target.args.map((_, i) => `"!BRAIN_A${i}!"`)].join(' '),
    'exit /b !ERRORLEVEL!',
    '',
  ].join('\r\n');
}

/**
 * Arguments captured by brain.cmd, or undefined when the program was not started through it.
 * BRAIN_SHIM_ARGS holds the echoed line "<prompt>rem @@@<raw arguments>@@@ ".
 */
export function cmdShimArgs(env: NodeJS.ProcessEnv): string[] | undefined {
  const line = env[SHIM_ARGS_ENV];
  if (line === undefined) return undefined;
  const open = `rem ${MARK}`;
  const start = line.indexOf(open);
  const end = line.lastIndexOf(MARK);
  if (start < 0 || end < start + open.length) return [];
  return splitWindowsArgs(line.slice(start + open.length, end));
}

/**
 * Split a Windows command line the way the C runtime and CommandLineToArgvW do:
 * spaces and tabs separate; "..." groups; 2n backslashes before a quote become n and the quote toggles,
 * 2n+1 become n plus a literal quote; "" inside quotes is a literal quote.
 */
export function splitWindowsArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inArg = false;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\') {
      let n = 0;
      while (s[i + n] === '\\') n++;
      if (s[i + n] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2 === 1) cur += '"';
        else quoted = !quoted;
        i += n;
      } else {
        cur += '\\'.repeat(n);
        i += n - 1;
      }
      inArg = true;
    } else if (ch === '"') {
      if (quoted && s[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        quoted = !quoted;
      }
      inArg = true;
    } else if ((ch === ' ' || ch === '\t') && !quoted) {
      if (inArg) out.push(cur);
      cur = '';
      inArg = false;
    } else {
      cur += ch;
      inArg = true;
    }
  }
  if (inArg) out.push(cur);
  return out;
}

/** Writes `brain` (POSIX, executable) and `brain.cmd` (Windows) into dir; returns their paths. */
export function writeBrainShims(dir: string, target: ShimTarget): { posix: string; cmd: string } {
  mkdirSync(dir, { recursive: true });
  const posix = join(dir, 'brain');
  const cmd = join(dir, 'brain.cmd');
  writeFileSync(posix, posixShim(target), { mode: 0o755 });
  chmodSync(posix, 0o755);
  writeFileSync(cmd, cmdShim(target));
  return { posix, cmd };
}
