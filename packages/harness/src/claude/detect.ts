import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Oldest Claude Code the hive will run insects on: the guard hook relies on
 * `onFailure: "block"` (added in 2.1.295) so a failed hook can never let a tool through.
 */
export const MIN_CLAUDE_VERSION = '2.1.295';

export function parseVersion(out: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
}

export function isSupportedVersion(version: string, min = MIN_CLAUDE_VERSION): boolean {
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

export type ClaudeInstall =
  | { status: 'installed'; command: string; version: string }
  | { status: 'outdated'; command: string; version: string; minimum: string }
  | { status: 'unsupported'; command: string; reason: string }
  | { status: 'missing' };

interface DetectDeps {
  run: (command: string, args: string[]) => Promise<string>;
  exists: (path: string) => boolean;
}

const defaultDeps: DetectDeps = {
  run: async (command, args) => (await execFileAsync(command, args, { timeout: 15_000, windowsHide: true })).stdout,
  exists: existsSync,
};

/** Where the official native installer puts the binary, plus everything on PATH. */
function candidates(env: NodeJS.ProcessEnv): string[] {
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const dirs = (env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter(Boolean);
  const home = env['USERPROFILE'] ?? env['HOME'] ?? homedir();
  return [...new Set([join(home, '.local', 'bin', name), ...dirs.map((d) => join(d, name))])];
}

export interface ClaudeAuth {
  loggedIn: boolean;
  method: string;
  expiresAt: string | null;
}

/**
 * Sign-in state without spending tokens: `claude auth status` prints JSON
 * (it exits 1 when signed out, so the output is read either way).
 */
export async function checkClaudeAuth(command: string, deps: Pick<DetectDeps, 'run'> = defaultAuthDeps): Promise<ClaudeAuth> {
  try {
    const raw = JSON.parse(await deps.run(command, ['auth', 'status'])) as Record<string, unknown>;
    return {
      loggedIn: raw['loggedIn'] === true,
      method: typeof raw['authMethod'] === 'string' ? raw['authMethod'] : 'unknown',
      expiresAt: typeof raw['loginExpiresAt'] === 'string' ? raw['loginExpiresAt'] : null,
    };
  } catch {
    return { loggedIn: false, method: 'unknown', expiresAt: null };
  }
}

const defaultAuthDeps: Pick<DetectDeps, 'run'> = {
  run: async (command, args) => {
    try {
      return (await execFileAsync(command, args, { timeout: 15_000, windowsHide: true })).stdout;
    } catch (err) {
      const out = (err as { stdout?: unknown }).stdout;
      if (typeof out === 'string' && out.trim()) return out;
      throw err;
    }
  },
};

/**
 * Find the Claude Code CLI (Connections 04-D2). Only a real executable is used:
 * an npm .cmd shim can't be started without a shell, which the harness never uses.
 */
export async function detectClaude(env: NodeJS.ProcessEnv = process.env, deps: DetectDeps = defaultDeps): Promise<ClaudeInstall> {
  for (const command of candidates(env)) {
    if (!deps.exists(command)) continue;
    let version: string | null;
    try {
      version = parseVersion(await deps.run(command, ['--version']));
    } catch {
      continue;
    }
    if (!version) continue;
    return isSupportedVersion(version)
      ? { status: 'installed', command, version }
      : { status: 'outdated', command, version, minimum: MIN_CLAUDE_VERSION };
  }
  if (process.platform === 'win32') {
    const shim = join(env['APPDATA'] ?? '', 'npm', 'claude.cmd');
    if (deps.exists(shim)) {
      return { status: 'unsupported', command: shim, reason: 'Only the npm launcher (.cmd) was found; install the native build so the hive can start it without a shell.' };
    }
  }
  return { status: 'missing' };
}
