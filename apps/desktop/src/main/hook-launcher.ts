import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HookRuntime {
  /** Program that runs the hook script, e.g. the app's own executable. */
  command: string;
  /** Environment the program needs, e.g. { ELECTRON_RUN_AS_NODE: '1' }. Set for the hook process only. */
  env: Record<string, string>;
}

/**
 * The guard hook runs on the app's own executable as Node, which needs ELECTRON_RUN_AS_NODE=1.
 * Putting that variable in Claude's environment would leak it into every shell command an insect
 * runs, and break any project that starts Electron. So the hook gets a tiny launcher that sets it
 * for itself only. The launcher takes no arguments (the hook reads its input from stdin), so there
 * is nothing for cmd.exe to re-parse.
 *
 * Returns how Claude Code should start the hook (`command` + `args`, no shell).
 */
export function writeHookLauncher(dir: string, runtime: HookRuntime, script: string, platform = process.platform): { command: string; args: string[] } {
  for (const [k, v] of Object.entries(runtime.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || /["\r\n\0]/.test(v)) throw new Error(`Invalid hook environment entry ${k}`);
  }
  for (const p of [runtime.command, script]) {
    if (/["\r\n\0]/.test(p)) throw new Error(`Hook path contains a quote or newline: ${p}`);
  }
  mkdirSync(dir, { recursive: true });

  if (platform === 'win32') {
    // In a batch file % starts a variable even inside quotes; %% is a literal %.
    const pct = (s: string): string => s.replace(/%/g, '%%');
    const file = join(dir, 'guard-hook.cmd');
    const lines = [
      '@echo off',
      'setlocal DisableDelayedExpansion',
      ...Object.entries(runtime.env).map(([k, v]) => `set "${k}=${pct(v)}"`),
      `"${pct(runtime.command)}" "${pct(script)}"`,
      'exit /b %ERRORLEVEL%',
    ];
    writeFileSync(file, `${lines.join('\r\n')}\r\n`);
    // cmd.exe is started directly (no shell); /d skips AutoRun, /c runs the launcher and returns its exit code.
    return { command: process.env['ComSpec'] ?? 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/c', file] };
  }

  const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const file = join(dir, 'guard-hook');
  const env = Object.entries(runtime.env).map(([k, v]) => `${k}=${sq(v)}`).join(' ');
  writeFileSync(file, `#!/bin/sh\nexec env ${env} ${sq(runtime.command)} ${sq(script)}\n`, { mode: 0o755 });
  chmodSync(file, 0o755);
  return { command: file, args: [] };
}
