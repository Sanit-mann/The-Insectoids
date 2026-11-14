import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Oldest OpenCode the hive runs. Config keys and flags were checked in the 2.2.1 and 2.2.5 source and in real
 * runs (Phase 2 C6). 2.2.6 is the minimum because 2.2.5 sends a run's first prompt before local MCP servers
 * register their tools, so an insect would start without the hive tools (fixed in 2.2.6, PR #60490).
 */
export const MIN_OPENCODE_VERSION = '2.2.6';

export type OpenCodeInstall =
  | { status: 'installed'; command: string; version: string; /** Tests: leading args (a stand-in script). */ args?: string[] }
  | { status: 'outdated'; command: string; version: string; minimum: string }
  | { status: 'missing' };

export interface OpenCodeDetectDeps {
  exists: (path: string) => boolean;
  /** Runs `<exe> --version` (no shell) and returns stdout. */
  version: (command: string) => Promise<string>;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

const defaultDeps = (): OpenCodeDetectDeps => ({
  exists: existsSync,
  version: async (command) => (await execFileAsync(command, ['--version'], { timeout: 15_000, windowsHide: true })).stdout,
  env: process.env,
  platform: process.platform,
});

const parse = (v: string): number[] => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
export function versionAtLeast(version: string, minimum: string): boolean {
  const a = parse(version);
  const b = parse(minimum);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/**
 * Where an install of OpenCode 2.x (npm `@opencode/cli`) puts its program:
 * the npm package's own binary (its install step copies the platform exe there), the default Windows
 * npm prefix, and every PATH folder. Always the real executable, never an npm `.cmd` launcher,
 * because the hive never starts anything through a shell.
 */
export function candidatePaths(d: Pick<OpenCodeDetectDeps, 'env' | 'platform'>): string[] {
  const win = d.platform === 'win32';
  const exe = win ? 'opencode.exe' : 'opencode';
  const out: string[] = [];
  if (win && d.env['APPDATA']) out.push(join(d.env['APPDATA'], 'npm', 'node_modules', '@opencode', 'cli', 'bin', exe));
  for (const dir of (d.env['PATH'] ?? d.env['Path'] ?? '').split(win ? ';' : delimiter).filter(Boolean)) {
    out.push(join(dir, 'node_modules', '@opencode', 'cli', 'bin', exe));
    out.push(join(dir, exe));
  }
  if (!win) out.push('/usr/local/lib/node_modules/@opencode/cli/bin/opencode', '/opt/homebrew/lib/node_modules/@opencode/cli/bin/opencode');
  return [...new Set(out)];
}

export async function detectOpenCode(deps: Partial<OpenCodeDetectDeps> = {}): Promise<OpenCodeInstall> {
  const d = { ...defaultDeps(), ...deps };
  for (const path of candidatePaths(d)) {
    if (!d.exists(path)) continue;
    let version: string | undefined;
    try {
      version = /(\d+\.\d+\.\d+)/.exec(await d.version(path))?.[1];
    } catch {
      continue;
    }
    if (!version) continue;
    if (!versionAtLeast(version, MIN_OPENCODE_VERSION)) return { status: 'outdated', command: path, version, minimum: MIN_OPENCODE_VERSION };
    return { status: 'installed', command: path, version };
  }
  return { status: 'missing' };
}

/**
 * OpenCode always loads a machine-wide config that outranks every other one and has no switch to turn it
 * off (2.2.1 `config/discovery.ts`). On Windows it lives in %ProgramData%\opencode and the run redirects
 * ProgramData to an empty folder, which OpenCode honours. On macOS and Linux the folder is fixed, so if
 * one exists (or a macOS managed-preferences profile is deployed) the hive refuses to run OpenCode: it
 * could switch the hive's safety settings off.
 */
export function blockingSystemConfig(
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
  user = process.env['USER'] ?? '',
): string | null {
  if (platform === 'win32') return null;
  const paths =
    platform === 'darwin'
      ? [
          '/Library/Application Support/opencode',
          ...(user ? [join('/Library/Managed Preferences', user, 'ai.opencode.managed.plist')] : []),
          '/Library/Managed Preferences/ai.opencode.managed.plist',
        ]
      : ['/etc/opencode'];
  return paths.find((p) => exists(p)) ?? null;
}
