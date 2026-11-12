import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { isSupportedVersion } from '../claude/detect';

const execFileAsync = promisify(execFile);

/**
 * Oldest Gemini CLI the hive runs: the per-run admin policy, `--allowed-mcp-server-names`, `-e none`,
 * `--skip-trust`, `hooksConfig.enabled`, the MCP env rules and the stream-json events were verified in the
 * 0.68.0 bundle (Gemini CLI updated itself from the pinned 0.66.0 on its first interactive run).
 */
export const MIN_GEMINI_VERSION = '0.68.0';
const PACKAGE = ['@google', 'gemini-cli'] as const;

export type GeminiInstall =
  | { status: 'installed'; script: string; version: string; node: string; nodeVersion: string }
  | { status: 'outdated'; script: string; version: string; minimum: string }
  | { status: 'no-node'; script: string; version: string; reason: string }
  | { status: 'missing' };

/** Gemini CLI needs Node.js 20 or newer. */
export const MIN_NODE_VERSION = '20.0.0';

export interface GeminiDetectDeps {
  /** Runs a command and returns its stdout (used for `npm root -g`). */
  run: (command: string, args: string[]) => Promise<string>;
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  /** Runs `<node> --version` without a shell. */
  runNode: (path: string) => Promise<string>;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

const defaultDeps = (): GeminiDetectDeps => ({
  run: async (command, args) =>
    (await execFileAsync(command, args, { timeout: 15_000, windowsHide: true, shell: process.platform === 'win32' })).stdout,
  exists: existsSync,
  readFile: (p) => readFileSync(p, 'utf8'),
  runNode: async (path) => (await execFileAsync(path, ['--version'], { timeout: 15_000, windowsHide: true })).stdout,
  env: process.env,
  platform: process.platform,
});

/**
 * Package folders where an npm install of Gemini CLI can live: `npm root -g`, the Windows default
 * prefix (%APPDATA%\npm), and every PATH folder holding a `gemini` launcher (npm puts the launcher in
 * the prefix and the package in prefix/node_modules on Windows, prefix/lib/node_modules elsewhere).
 */
async function packageDirs(d: GeminiDetectDeps): Promise<string[]> {
  const dirs: string[] = [];
  try {
    const root = (await d.run('npm', ['root', '-g'])).trim().split(/\r?\n/).pop()?.trim();
    if (root) dirs.push(join(root, ...PACKAGE));
  } catch {
    // npm not on PATH: fall back to the usual places.
  }
  const win = d.platform === 'win32';
  if (win && d.env['APPDATA']) dirs.push(join(d.env['APPDATA'], 'npm', 'node_modules', ...PACKAGE));
  for (const dir of (d.env['PATH'] ?? d.env['Path'] ?? '').split(delimiter).filter(Boolean)) {
    if (win ? d.exists(join(dir, 'gemini.cmd')) : d.exists(join(dir, 'gemini'))) {
      dirs.push(win ? join(dir, 'node_modules', ...PACKAGE) : join(dirname(dir), 'lib', 'node_modules', ...PACKAGE));
    }
  }
  return [...new Set(dirs)];
}

/**
 * Finds Gemini CLI's JavaScript entry (bundle/gemini.js). The hive starts it with a JavaScript runtime
 * and no shell, never through the `gemini.cmd` launcher.
 */
export async function detectGemini(deps: Partial<GeminiDetectDeps> = {}): Promise<GeminiInstall> {
  const d = { ...defaultDeps(), ...deps };
  for (const dir of await packageDirs(d)) {
    const script = join(dir, 'bundle', 'gemini.js');
    if (!d.exists(script)) continue;
    let version: string | null;
    try {
      const pkg = JSON.parse(d.readFile(join(dir, 'package.json'))) as { version?: unknown };
      version = typeof pkg.version === 'string' ? pkg.version : null;
    } catch {
      version = null;
    }
    if (!version) continue;
    if (!isSupportedVersion(version, MIN_GEMINI_VERSION)) return { status: 'outdated', script, version, minimum: MIN_GEMINI_VERSION };
    const node = await findNode(d, dir);
    if (!node) return { status: 'no-node', script, version, reason: 'Gemini CLI needs Node.js 20 or newer, and none was found on this computer.' };
    return { status: 'installed', script, version, node: node.path, nodeVersion: node.version };
  }
  return { status: 'missing' };
}

/**
 * Node.js for Gemini runs: one next to the npm launcher first (some installs ship it there), then PATH.
 * Version 20 or newer, checked with `node --version` (no shell).
 */
async function findNode(d: GeminiDetectDeps, packageDir: string): Promise<{ path: string; version: string } | null> {
  const name = d.platform === 'win32' ? 'node.exe' : 'node';
  const prefix = d.platform === 'win32' ? dirname(dirname(dirname(packageDir))) : dirname(dirname(dirname(dirname(packageDir))));
  const dirs = [d.platform === 'win32' ? prefix : join(prefix, 'bin'), ...(d.env['PATH'] ?? d.env['Path'] ?? '').split(delimiter).filter(Boolean)];
  for (const dir of [...new Set(dirs)]) {
    const path = join(dir, name);
    if (!d.exists(path)) continue;
    try {
      const v = /v?(\d+\.\d+\.\d+)/.exec(await d.runNode(path))?.[1];
      if (v && isSupportedVersion(v, MIN_NODE_VERSION)) return { path, version: v };
    } catch {
      // Not runnable: try the next one.
    }
  }
  return null;
}

export interface GeminiAuth {
  signedIn: boolean;
  /** e.g. oauth-personal (Login with Google), gemini-api-key, vertex-ai; null when never chosen. */
  method: string | null;
}

export interface GeminiAuthDeps {
  home: string;
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  env: NodeJS.ProcessEnv;
}

/**
 * Sign-in state without spending quota: Gemini CLI has no status command. Reads only the chosen
 * sign-in method from ~/.gemini/settings.json and whether the credentials file exists.
 * The credentials themselves are never opened.
 */
export function checkGeminiAuth(deps: Partial<GeminiAuthDeps> = {}): GeminiAuth {
  const d: GeminiAuthDeps = { home: homedir(), exists: existsSync, readFile: (p) => readFileSync(p, 'utf8'), env: process.env, ...deps };
  const dir = join(d.home, '.gemini');
  let method: string | null;
  try {
    const s = JSON.parse(d.readFile(join(dir, 'settings.json'))) as Record<string, unknown>;
    const security = (s['security'] ?? {}) as { auth?: { selectedType?: unknown } };
    const picked = security.auth?.selectedType ?? s['selectedAuthType'];
    method = typeof picked === 'string' ? picked : null;
  } catch {
    method = null;
  }
  if (method === 'oauth-personal') return { signedIn: d.exists(join(dir, 'oauth_creds.json')), method };
  if (method === 'gemini-api-key') return { signedIn: Boolean(d.env['GEMINI_API_KEY']), method };
  if (method === 'vertex-ai') return { signedIn: Boolean(d.env['GOOGLE_CLOUD_PROJECT'] || d.env['GOOGLE_API_KEY']), method };
  return { signedIn: false, method };
}

/** Gemini CLI's machine-wide policy folder (Storage.getSystemPoliciesDir in 0.68.0). */
export function machinePolicyDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Library/Application Support/GeminiCli/policies';
  if (platform === 'win32') return 'C:\\ProgramData\\gemini-cli\\policies';
  return '/etc/gemini-cli/policies';
}

/**
 * Gemini CLI ignores `--admin-policy` when the machine has its own admin policies (any .toml in the
 * folder above). The hive's policy would then not apply, so the hive refuses to run Gemini there.
 */
export function hasMachinePolicies(
  platform: NodeJS.Platform = process.platform,
  list: (dir: string) => string[] = (dir) => readdirSync(dir),
): boolean {
  try {
    return list(machinePolicyDir(platform)).some((f) => f.endsWith('.toml'));
  } catch {
    return false;
  }
}
