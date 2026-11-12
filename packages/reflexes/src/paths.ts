import path from 'node:path';

export interface PathContext {
  platform?: 'win32' | 'posix';
  /** The card's workspace (its git worktree). */
  workspace: string;
  home: string;
  /** Folders linked into the workspace (e.g. node_modules); they point at the user's real files. */
  linkedPaths?: string[];
  /** Folders the user marked "no-go" (Workspace 06-D8). */
  noGo?: string[];
  /**
   * Resolve symlinks and junctions on the real file system (the hook adapter supplies one).
   * Without it, a link inside the workspace pointing outside could be written through.
   */
  realpath?: (abs: string) => string;
}

const impl = (ctx: PathContext) => ((ctx.platform ?? (process.platform === 'win32' ? 'win32' : 'posix')) === 'win32' ? path.win32 : path.posix);

/** Expand ~, $HOME, ${HOME}, %USERPROFILE% and $env:USERPROFILE, then resolve against the workspace. */
export function resolveIn(arg: string, ctx: PathContext): string {
  const P = impl(ctx);
  let p = arg;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = ctx.home + p.slice(1);
  p = p.replace(/^(\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE|\$env:HOME)(?=$|[\\/])/i, ctx.home);
  const abs = P.resolve(ctx.workspace, p);
  return ctx.realpath ? ctx.realpath(abs) : abs;
}

export function isInside(child: string, parent: string, ctx: PathContext): boolean {
  const P = impl(ctx);
  const rel = P.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !P.isAbsolute(rel));
}

const SAFE_ENV_FILES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist']);
const SECRET_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.kdbx', '.ppk', '.jks'];
const SECRET_FILES = new Set(['.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials', '.pgpass', '.htpasswd']);
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', '.password-store']);
const BROWSER_PROFILES = [
  '/google/chrome/user data',
  '/microsoft/edge/user data',
  '/bravesoftware/brave-browser/user data',
  '/mozilla/firefox/profiles',
  '/.mozilla/firefox',
  '/.config/google-chrome',
  '/.config/chromium',
  '/.config/gcloud',
  '/library/application support/google/chrome',
  '/library/application support/firefox',
];

/** Files no insect may read or write: env files, keys, credentials, browser profiles (Workspace 06-D8). */
export function protectedReason(abs: string): string | null {
  const unix = `/${abs.replace(/\\/g, '/').toLowerCase()}`;
  const parts = unix.split('/').filter(Boolean);
  const name = parts.at(-1) ?? '';
  if (name === '.env' || (name.startsWith('.env.') && !SAFE_ENV_FILES.has(name))) return 'an environment file (.env)';
  if (SECRET_EXTENSIONS.some((ext) => name.endsWith(ext))) return 'a key or certificate file';
  if (/^id_(rsa|ed25519|ecdsa|dsa)/.test(name)) return 'an SSH key';
  if (SECRET_FILES.has(name)) return 'a credentials file';
  if (parts.some((p) => SECRET_DIRS.has(p))) return 'a credentials folder';
  if (BROWSER_PROFILES.some((b) => unix.includes(b))) return 'a browser profile';
  return null;
}

export function noGoHit(abs: string, ctx: PathContext): boolean {
  return (ctx.noGo ?? []).some((dir) => isInside(abs, impl(ctx).resolve(dir), ctx));
}

export function linkedHit(abs: string, ctx: PathContext): boolean {
  return (ctx.linkedPaths ?? []).some((dir) => isInside(abs, impl(ctx).resolve(dir), ctx));
}

export function isGitInternals(abs: string, ctx: PathContext): boolean {
  if (!isInside(abs, ctx.workspace, ctx)) return false;
  const rel = impl(ctx).relative(ctx.workspace, abs).replace(/\\/g, '/');
  return rel === '.git' || rel.startsWith('.git/');
}

/** Does a command argument look like a file path worth checking? */
export function looksLikePath(arg: string): boolean {
  return /[\\/]/.test(arg) || arg.startsWith('.') || arg.startsWith('~') || /^[A-Za-z]:/.test(arg) || /^\$(HOME|\{HOME\}|env:)|^%USERPROFILE%/i.test(arg);
}
