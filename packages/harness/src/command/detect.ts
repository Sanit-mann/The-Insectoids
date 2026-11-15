import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { versionAtLeast } from '../opencode/detect';
import type { CommandPreset } from './preset';

const execFileAsync = promisify(execFile);

export type CommandInstall =
  | { status: 'installed'; command: string; args: string[]; version: string }
  | { status: 'outdated'; command: string; version: string; minimum: string }
  /** Found, but not in a form the hive can start safely (e.g. a launcher script it can't read), or no version. */
  | { status: 'unsupported'; command: string; reason: string }
  | { status: 'missing' };

export interface CommandDetectDeps {
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  /** Runs a program without a shell and returns stdout and stderr (also when it exits non-zero). */
  run: (command: string, args: readonly string[]) => Promise<string>;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

const defaultDeps = (): CommandDetectDeps => ({
  exists: existsSync,
  readFile: (p) => readFileSync(p, 'utf8'),
  run: async (command, args) => {
    try {
      const r = await execFileAsync(command, [...args], { timeout: 15_000, windowsHide: true });
      return `${r.stdout}\n${r.stderr}`;
    } catch (err) {
      const e = err as { stdout?: unknown; stderr?: unknown };
      const out = `${typeof e.stdout === 'string' ? e.stdout : ''}\n${typeof e.stderr === 'string' ? e.stderr : ''}`;
      if (out.trim()) return out;
      throw err;
    }
  },
  env: process.env,
  platform: process.platform,
});

const pathDirs = (d: Pick<CommandDetectDeps, 'env' | 'platform'>): string[] =>
  (d.env['PATH'] ?? d.env['Path'] ?? '').split(d.platform === 'win32' ? ';' : delimiter).filter(Boolean);

/**
 * The program an npm launcher (`name.cmd`, made by cmd-shim) starts: its last `"%dp0%\…"` target. A native
 * program is started directly; a JavaScript entry with Node.js (next to the launcher, else on PATH). Null
 * when the launcher isn't one the hive can read: then it refuses rather than start it through a shell.
 */
export function resolveCmdShim(text: string, shimDir: string, d: Pick<CommandDetectDeps, 'exists' | 'env' | 'platform'>): { command: string; args: string[] } | null {
  const targets = [...text.matchAll(/"%(?:~dp0|dp0%)\\?([^"%]+\.(exe|js|cjs|mjs))"/gi)];
  const last = targets.at(-1);
  if (!last) return null;
  const target = join(shimDir, last[1]!);
  if (!d.exists(target)) return null;
  if (last[2]!.toLowerCase() === 'exe') return { command: target, args: [] };
  const node = [shimDir, ...pathDirs(d)].map((dir) => join(dir, 'node.exe')).find((p) => d.exists(p));
  return node ? { command: node, args: [target] } : null;
}

type Found = { command: string; args: string[] } | { unsupported: string; command: string };

/** The preset's program on PATH: a real executable first; on Windows an npm launcher is read, never run. */
export function findCommand(p: CommandPreset, d: Pick<CommandDetectDeps, 'exists' | 'readFile' | 'env' | 'platform'>): Found | null {
  const win = d.platform === 'win32';
  let shim: string | null = null;
  for (const dir of pathDirs(d)) {
    const exe = join(dir, win ? `${p.executable}.exe` : p.executable);
    if (d.exists(exe)) return { command: exe, args: [] };
    const cmd = join(dir, `${p.executable}.cmd`);
    if (win && !shim && d.exists(cmd)) shim = cmd;
  }
  if (!shim) return null;
  let resolved: { command: string; args: string[] } | null;
  try {
    resolved = resolveCmdShim(d.readFile(shim), join(shim, '..'), d);
  } catch {
    resolved = null;
  }
  return (
    resolved ?? {
      command: shim,
      unsupported: `Only a launcher script (${shim}) was found for ${p.name}, and the hive can't tell what it starts. The hive never starts programs through a shell, so it won't use it.`,
    }
  );
}

/** Finds the preset's CLI and checks its version (no shell, no tokens). */
export async function detectCommand(p: CommandPreset, deps: Partial<CommandDetectDeps> = {}): Promise<CommandInstall> {
  const d = { ...defaultDeps(), ...deps };
  const found = findCommand(p, d);
  if (!found) return { status: 'missing' };
  if ('unsupported' in found) return { status: 'unsupported', command: found.command, reason: found.unsupported };
  let out: string;
  try {
    out = await d.run(found.command, [...found.args, ...p.version.args]);
  } catch (err) {
    return { status: 'unsupported', command: found.command, reason: `${p.name} was found but didn't start (${err instanceof Error ? err.message : String(err)}).` };
  }
  const version = p.version.pattern.exec(out)?.[1];
  if (!version) return { status: 'unsupported', command: found.command, reason: `${p.name} was found, but the hive couldn't read its version.` };
  if (!versionAtLeast(version, p.version.minimum)) return { status: 'outdated', command: found.command, version, minimum: p.version.minimum };
  return { status: 'installed', command: found.command, args: found.args, version };
}

/**
 * Signed in? From the CLI's own status command only (never its credential files). Null when the preset has
 * no such check (the hive can't tell); a check that doesn't run counts as signed out.
 */
export async function checkCommandSignIn(
  p: CommandPreset,
  install: { command: string; args: string[] },
  deps: Partial<Pick<CommandDetectDeps, 'run'>> = {},
): Promise<boolean | null> {
  if (!p.signedInCheck) return null;
  const run = deps.run ?? defaultDeps().run;
  try {
    return p.signedInCheck.signedIn.test(await run(install.command, [...install.args, ...p.signedInCheck.args]));
  } catch {
    return false;
  }
}
