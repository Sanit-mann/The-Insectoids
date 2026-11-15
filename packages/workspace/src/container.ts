import { type ChildProcess, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { CONTAINER_WORKDIR, type ContainerPolicy, type ContainerRuntimeKind } from '@insectoids/reflexes';
import { ContainerImageSchema } from '@insectoids/shared';

/**
 * Container mode runtime layer (Phase 4 D1; Workspace & Safety 06-D4): find Docker or Podman, build the argv for
 * one throwaway container per command, check and pull the image, and clean up containers by name or label.
 *
 * Everything here starts the runtime program directly (never through a shell), and nothing here installs
 * anything: when there is no runtime the caller tells the user where to get one.
 */

export interface RuntimeFound {
  kind: ContainerRuntimeKind;
  /** The runtime program: a real executable (docker.exe / podman.exe on Windows), or the fake runtime's Node. */
  command: string;
  commandArgs: string[];
  version: string | null;
  /** Docker: the client reached its service. Podman: `podman version` succeeded (on Windows/macOS, its machine is up). */
  running: boolean;
}

export type RunResult = { code: number | null; stdout: string; stderr: string };
export type RunFn = (cmd: string, args: string[]) => Promise<RunResult>;
type Runtime = Pick<RuntimeFound, 'command' | 'commandArgs'>;
/** Environment for the runtime program itself (not the container: nothing from here goes into a container). */
export interface RuntimeExecOptions {
  env?: NodeJS.ProcessEnv;
}

/** Every container the hive starts carries this label, so leftovers from a crash can be found and removed. */
export const CONTAINER_LABEL = 'io.insectoids.run';

const PROBE_TIMEOUT_MS = 15_000;

/** Runs the runtime program without a shell and collects its output; a program that can't start gives code null. */
function exec(cmd: string, args: string[], o: RuntimeExecOptions & { timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { env: o.env ?? process.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs ?? PROBE_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const defaultExists = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Windows environment names are case-insensitive (PATH is often "Path"); a plain object isn't. */
function pathValue(env: NodeJS.ProcessEnv, win: boolean): string {
  if (!win) return env['PATH'] ?? '';
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return key ? (env[key] ?? '') : '';
}

/**
 * Looks for a program on PATH as a real executable only. On Windows that means `<name>.exe`: a .cmd or .bat
 * would have to be started through cmd.exe, which re-reads its arguments as shell text (and a planted
 * docker.cmd earlier on PATH must not win).
 */
function findOnPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (p: string) => boolean): string | null {
  const win = platform === 'win32';
  const P = win ? path.win32 : path.posix;
  for (const raw of pathValue(env, win).split(win ? ';' : ':')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    // A relative PATH entry would make the result depend on the current folder: skip it.
    if (!dir || !P.isAbsolute(dir)) continue;
    const candidate = P.join(dir, win ? `${name}.exe` : name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

type VersionJson = { Client?: Record<string, unknown> | null; Server?: Record<string, unknown> | null };

function parseVersionJson(stdout: string): VersionJson | null {
  // Docker prints one JSON object; take the first {...} line in case the runtime adds a warning line.
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      return JSON.parse(t) as VersionJson;
    } catch {
      /* try the next line */
    }
  }
  try {
    return JSON.parse(stdout) as VersionJson;
  } catch {
    return null;
  }
}

/**
 * Podman's client JSON spells it "APIVersion"; Docker's says "ApiVersion" and has "Platform". The JSON decides
 * the flavour rather than the program's name, because `docker` is sometimes Podman's docker shim.
 */
function flavourOf(v: VersionJson | null, fallback: ContainerRuntimeKind): ContainerRuntimeKind {
  const client = v?.Client;
  if (!client) return fallback;
  if ('APIVersion' in client && !('ApiVersion' in client)) return 'podman';
  if ('ApiVersion' in client || 'Platform' in client) return 'docker';
  return fallback;
}

async function probe(command: string, commandArgs: string[], guess: ContainerRuntimeKind, run: RunFn): Promise<RuntimeFound | null> {
  const r = await run(command, [...commandArgs, 'version', '--format', 'json']);
  // Could not start the program at all: treat it as not found.
  if (r.code === null && !r.stdout) return null;
  const v = parseVersionJson(r.stdout);
  const kind = flavourOf(v, guess);
  const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
  const server = v?.Server && typeof v.Server === 'object' ? v.Server : null;
  // Docker: a client whose service doesn't answer prints Server: null (and exits 1). Podman on Linux has no
  // separate service, so its exit code is the answer.
  const running = kind === 'docker' ? r.code === 0 && (v ? server !== null : true) : r.code === 0;
  return { kind, command, commandArgs, version: str(server?.['Version']) ?? str(v?.Client?.['Version']), running };
}

/**
 * Finds a container runtime: Docker first, then Podman (a running one wins over one that isn't answering).
 * Never installs anything and never goes through a shell. `override` (the e2e fake runtime) skips the search.
 */
export async function detectContainerRuntime(
  o: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    exists?: (p: string) => boolean;
    run?: RunFn;
    override?: { command: string; commandArgs: string[] };
  } = {},
): Promise<RuntimeFound | null> {
  const env = o.env ?? process.env;
  const run: RunFn = o.run ?? ((cmd, args) => exec(cmd, args, { env }));
  if (o.override) return probe(o.override.command, o.override.commandArgs, 'docker', run);
  const platform = o.platform ?? process.platform;
  const exists = o.exists ?? defaultExists;
  let fallback: RuntimeFound | null = null;
  for (const kind of ['docker', 'podman'] as const) {
    const program = findOnPath(kind, env, platform, exists);
    if (!program) continue;
    const found = await probe(program, [], kind, run);
    if (found?.running) return found;
    fallback ??= found;
  }
  return fallback;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The argv after the runtime program for one throwaway container that runs `command` with `sh -c`:
 * removed when done, only the worktree mounted (at /work), no capabilities, no new privileges, read-only root
 * with a small /tmp, CPU/memory/process limits, network none or bridge, and only `o.env` as its environment.
 * Throws (plain words) on anything that could be misread by the runtime.
 */
export function containerRunArgs(p: ContainerPolicy, o: { workspace: string; command: string; index: number; env?: Record<string, string>; user?: string }): string[] {
  // --mount is a comma-separated list of key=value, so a comma in the path would start a new option.
  if (/[,\r\n]/.test(o.workspace)) {
    throw new Error(`Container mode can't use this workspace folder: its path contains a comma or a line break (${JSON.stringify(o.workspace)}).`);
  }
  if (!path.win32.isAbsolute(o.workspace) && !path.posix.isAbsolute(o.workspace)) {
    throw new Error(`Container mode needs the workspace as a full path, not "${o.workspace}".`);
  }
  const image = ContainerImageSchema.safeParse(p.image);
  if (!image.success || image.data !== p.image) {
    throw new Error(`"${p.image}" isn't an image name the app can use (like node:22-bookworm-slim).`);
  }
  if (!NAME.test(p.name)) {
    throw new Error(`"${p.name}" can't name a container: use lowercase letters, digits and dashes only.`);
  }
  if (!Number.isInteger(o.index) || o.index < 0) throw new Error(`Container number must be a whole number, not ${o.index}.`);
  const positive = (label: string, n: number, whole: boolean): string => {
    if (!Number.isFinite(n) || n <= 0 || (whole && !Number.isInteger(n))) throw new Error(`The container's ${label} limit must be a positive number, not ${n}.`);
    return String(n);
  };
  const cpus = positive('CPU', p.cpus, false);
  const memory = `${positive('memory', p.memoryMb, true)}m`;
  const pids = positive('process', p.pidsLimit, true);
  const envArgs: string[] = [];
  if (o.user !== undefined && !/^\d{1,10}:\d{1,10}$/.test(o.user)) throw new Error(`"${o.user}" isn't a user the container can run as (it takes uid:gid).`);
  for (const [k, v] of Object.entries(o.env ?? {})) {
    if (!ENV_KEY.test(k)) throw new Error(`"${k}" isn't a variable name the container can take.`);
    if (v.includes('\0')) throw new Error(`The value for ${k} contains a null character.`);
    envArgs.push('-e', `${k}=${v}`);
  }
  return [
    'run',
    '--rm',
    '-i',
    '--name', `${p.name}-${o.index}`,
    '--label', `${CONTAINER_LABEL}=${p.name}`,
    // Never download an image as a side effect of a command: pulling is the user's click (container-api).
    '--pull', 'never',
    '--network', p.network === 'open' ? 'bridge' : 'none',
    '--cpus', cpus,
    '--memory', memory,
    // Same as --memory: no swap on top of the memory limit.
    '--memory-swap', memory,
    '--pids-limit', pids,
    '--read-only',
    '--tmpfs', '/tmp:rw,size=256m',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    // Rootless Podman maps the user's id to root inside; keep-id keeps it, so files in /work stay the user's.
    ...(p.runtime === 'podman' ? ['--userns=keep-id'] : []),
    // Docker on Linux runs as root unless told otherwise: run as the user, so files in /work stay theirs.
    ...(o.user ? ['--user', o.user] : []),
    // --mount, not -v: -v splits on ":" and breaks on Windows paths like C:\Users\….
    '--mount', `type=bind,source=${o.workspace},target=${CONTAINER_WORKDIR}`,
    '-w', CONTAINER_WORKDIR,
    ...envArgs,
    p.image,
    'sh', '-c', o.command,
  ];
}

const argsOf = (rt: Runtime, args: string[]): string[] => [...(rt.commandArgs ?? []), ...args];

/** Is the image on this computer? (`image inspect`; any failure counts as no.) */
export async function imagePresent(rt: Runtime, image: string, o: RuntimeExecOptions = {}): Promise<boolean> {
  const r = await exec(rt.command, argsOf(rt, ['image', 'inspect', image]), o);
  return r.code === 0;
}

/**
 * Downloads the image (only ever on the user's click). Progress comes line by line; `stop()` cancels the pull.
 * Docker redraws progress with carriage returns, so those split lines too.
 */
export function pullImage(rt: Runtime, image: string, onLine: (line: string) => void, o: RuntimeExecOptions = {}): { done: Promise<{ ok: boolean; error?: string }>; stop(): void } {
  let child: ChildProcess | null = null;
  let stopped = false;
  const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    try {
      child = spawn(rt.command, argsOf(rt, ['pull', image]), { env: o.env ?? process.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    let lastErr = '';
    const feed = (isErr: boolean) => {
      let buf = '';
      return (d: string) => {
        buf += d;
        const parts = buf.split(/\r\n|\r|\n/);
        buf = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.trim();
          if (!line) continue;
          if (isErr) lastErr = line;
          onLine(line);
        }
      };
    };
    child.stdout?.setEncoding('utf8').on('data', feed(false));
    child.stderr?.setEncoding('utf8').on('data', feed(true));
    child.on('error', (err) => resolve({ ok: false, error: `Could not start ${rt.command}: ${err.message}` }));
    child.on('close', (code) => {
      if (stopped) resolve({ ok: false, error: 'The download was stopped.' });
      else if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: lastErr || `The download failed (exit code ${code ?? 'unknown'}).` });
    });
  });
  return {
    done,
    stop() {
      stopped = true;
      (child as ChildProcess | null)?.kill();
    },
  };
}

/**
 * Stops one container by name (a timeout). Failures are ignored: it may already be gone. If `kill` fails while
 * the container still exists (e.g. created, not started yet), `rm -f` removes it anyway.
 */
export async function killContainer(rt: Runtime, name: string, o: RuntimeExecOptions = {}): Promise<void> {
  const r = await exec(rt.command, argsOf(rt, ['kill', name]), o);
  if (r.code !== 0) await exec(rt.command, argsOf(rt, ['rm', '-f', name]), o);
}

/** Removes every container the hive started that is still around (after a crash). Returns how many. */
export async function removeLeftovers(rt: Runtime, o: RuntimeExecOptions = {}): Promise<number> {
  return removeLabelled(rt, CONTAINER_LABEL, o);
}

/** Removes one run's containers (labelled with its name), e.g. when the hive stops or ends that run. */
export async function removeRunContainers(rt: Runtime, run: string, o: RuntimeExecOptions = {}): Promise<number> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(run)) return 0;
  return removeLabelled(rt, `${CONTAINER_LABEL}=${run}`, o);
}

async function removeLabelled(rt: Runtime, label: string, o: RuntimeExecOptions): Promise<number> {
  const ps = await exec(rt.command, argsOf(rt, ['ps', '-aq', '--filter', `label=${label}`]), o);
  if (ps.code !== 0) return 0;
  const ids = [...new Set(ps.stdout.split(/\s+/).filter(Boolean))];
  if (!ids.length) return 0;
  const rm = await exec(rt.command, argsOf(rt, ['rm', '-f', ...ids]), o);
  return rm.code === 0 ? ids.length : 0;
}
