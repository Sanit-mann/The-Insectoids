#!/usr/bin/env node
/**
 * A stand-in `docker` for tests and the e2e (Phase 4 D1). It starts no containers: `run` parses the flags the
 * hive passes, then runs the `sh -c` command on this computer with its working folder set to the --mount
 * source, so files written in /work land in the worktree just as with a real bind mount. On Windows the command
 * runs with cmd.exe (tests only use simple commands like `echo hi > out.txt`).
 *
 * Use it as { command: process.execPath, commandArgs: ['<path to this file>'] } (Node, not Electron).
 *
 * Environment knobs:
 *   FAKE_RUNTIME_FLAVOR  docker (default) | podman: the shape of `version --format json` and the error wording.
 *   FAKE_RUNTIME_SERVER  up (default) | down: down = the client works but its service doesn't answer.
 *   FAKE_RUNTIME_VERSION the version to report (default 27.3.1 for docker, 5.2.0 for podman).
 *   FAKE_RUNTIME_STATE   JSON file for pulled images and live containers (default: <tmp>/insectoids-fake-runtime-state.json).
 *   FAKE_RUNTIME_LOG     if set, every call's argv (after the program) is appended to it as one JSON array per line.
 *   FAKE_RUNTIME_IMAGES  comma-separated images treated as already on this computer.
 *   FAKE_RUNTIME_PULL    ok (default) | fail | slow: `pull` succeeds quickly, fails after one line, or takes ~20 s.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = process.env;
const argv = process.argv.slice(2);
const win = process.platform === 'win32';
const flavour = env.FAKE_RUNTIME_FLAVOR === 'podman' ? 'podman' : 'docker';
const serverUp = env.FAKE_RUNTIME_SERVER !== 'down';
const version = env.FAKE_RUNTIME_VERSION || (flavour === 'podman' ? '5.2.0' : '27.3.1');
const statePath = env.FAKE_RUNTIME_STATE || join(tmpdir(), 'insectoids-fake-runtime-state.json');

if (env.FAKE_RUNTIME_LOG) appendFileSync(env.FAKE_RUNTIME_LOG, `${JSON.stringify(argv)}\n`);

/** @returns {{ images: string[], containers: Record<string, { image?: string, labels?: Record<string, string>, pid?: number, childPid?: number }> }} */
function readState() {
  try {
    const s = JSON.parse(readFileSync(statePath, 'utf8'));
    return { images: Array.isArray(s.images) ? s.images : [], containers: s.containers && typeof s.containers === 'object' ? s.containers : {} };
  } catch {
    return { images: [], containers: {} };
  }
}
function writeState(s) {
  // Write then rename, so a concurrent reader never sees half a file.
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, statePath);
}
const updateState = (fn) => {
  const s = readState();
  fn(s);
  writeState(s);
};

const out = (s) => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cannotConnect(prefix = '') {
  err(
    flavour === 'podman'
      ? 'Error: Cannot connect to Podman. Please verify your connection to the Linux system using `podman system connection list`, or try `podman machine init` and `podman machine start` to manage a new Linux VM'
      : `${prefix}Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?`,
  );
}

function hasImage(image) {
  const preloaded = (env.FAKE_RUNTIME_IMAGES || '').split(',').map((s) => s.trim()).filter(Boolean);
  return preloaded.includes(image) || readState().images.includes(image);
}

function killPids(c) {
  for (const pid of [c.childPid, c.pid]) {
    if (!pid) continue;
    try {
      if (win) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          process.kill(pid, 'SIGKILL');
        }
      }
    } catch {
      /* already gone */
    }
  }
}

function cmdVersion() {
  const client =
    flavour === 'podman'
      ? { APIVersion: version, Version: version, GoVersion: 'go1.22.5', OsArch: 'linux/amd64', Os: 'linux' }
      : { Platform: { Name: '' }, Version: version, ApiVersion: '1.47', Os: process.platform, Arch: 'amd64', Context: 'default' };
  const server =
    flavour === 'podman'
      ? { APIVersion: version, Version: version, OsArch: 'linux/amd64', Os: 'linux' }
      : { Platform: { Name: 'Docker Engine - Community' }, Version: version, ApiVersion: '1.47', Os: 'linux', Arch: 'amd64' };
  if (!serverUp) {
    out(JSON.stringify(flavour === 'podman' ? { Client: client } : { Client: client, Server: null }));
    cannotConnect();
    return flavour === 'podman' ? 125 : 1;
  }
  out(JSON.stringify({ Client: client, Server: server }));
  return 0;
}

function cmdImageInspect(images) {
  if (!serverUp) return (cannotConnect(), 1);
  const found = [];
  let rc = 0;
  for (const image of images) {
    if (hasImage(image)) found.push({ Id: 'sha256:fake', RepoTags: [image.split('@')[0]] });
    else {
      err(`Error: No such image: ${image}`);
      rc = 1;
    }
  }
  out(JSON.stringify(found));
  return rc;
}

async function cmdPull(image) {
  if (!image) return (err('"pull" requires exactly 1 argument.'), 1);
  if (!serverUp) return (cannotConnect(), 1);
  const mode = env.FAKE_RUNTIME_PULL || 'ok';
  const [name] = image.split('@');
  out(`${name.split(':')[1] || 'latest'}: Pulling from library/${name.split(':')[0]}`);
  if (mode === 'fail') {
    await sleep(20);
    err(`Error response from daemon: manifest for ${image} not found: manifest unknown`);
    return 1;
  }
  const steps = mode === 'slow' ? 20 : 4;
  for (let i = 1; i <= steps; i++) {
    await sleep(mode === 'slow' ? 1000 : 10);
    // Progress redraws with a carriage return, like Docker's.
    process.stdout.write(`a1b2c3d4e5f6: Downloading  ${i * 10}MB/${steps * 10}MB\r`);
  }
  out('');
  out('a1b2c3d4e5f6: Pull complete');
  out('Digest: sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9');
  out(`Status: Downloaded newer image for ${image}`);
  updateState((s) => {
    if (!s.images.includes(image)) s.images.push(image);
  });
  return 0;
}

const RUN_VALUE_FLAGS = new Set(['--name', '--label', '--pull', '--network', '--cpus', '--memory', '--memory-swap', '--pids-limit', '--tmpfs', '--cap-drop', '--security-opt', '--mount', '-w', '--workdir', '-e', '--env', '--user', '-u', '--userns']);
const RUN_BOOL_FLAGS = new Set(['--rm', '-i', '--interactive', '--read-only', '-t', '--init']);

async function cmdRun(args) {
  const flags = {};
  const add = (k, v) => (flags[k] ??= []).push(v);
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) break;
    const eq = a.indexOf('=');
    const key = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    if (RUN_BOOL_FLAGS.has(key)) add(key, true);
    else if (RUN_VALUE_FLAGS.has(key)) {
      if (eq > 0 && a.startsWith('--')) add(key, a.slice(eq + 1));
      else if (i + 1 < args.length) add(key, args[++i]);
      else return (err(`${flavour}: flag needs an argument: ${key}`), 125);
    } else return (err(`${flavour}: unknown flag: ${key}`), 125);
  }
  const image = args[i];
  const rest = args.slice(i + 1);
  if (!image) return (err(`${flavour}: "run" requires at least 1 argument.`), 125);
  if (!serverUp) return (cannotConnect('docker: '), 125);
  if (!hasImage(image)) {
    err(`${flavour === 'podman' ? 'Error' : 'docker: Error response from daemon'}: No such image: ${image}`);
    return 125;
  }
  if (rest[0] !== 'sh' || rest[1] !== '-c' || rest.length !== 3) return (err('fake runtime: only `sh -c <command>` is supported'), 127);
  const command = rest[2];

  const mount = (flags['--mount'] || [])[0] || '';
  const opts = Object.fromEntries(mount.split(',').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  const source = opts.source || opts.src;
  if (!source || !existsSync(source) || !statSync(source).isDirectory()) {
    err(`${flavour}: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: ${source}`);
    return 125;
  }
  const name = (flags['--name'] || [])[0] || `fake-${process.pid}`;
  const labels = Object.fromEntries((flags['--label'] || []).map((l) => [l.split('=')[0], l.split('=').slice(1).join('=')]));
  const state = readState();
  if (state.containers[name]) {
    err(`${flavour}: Error response from daemon: Conflict. The container name "/${name}" is already in use.`);
    return 125;
  }

  // Like a container: nothing from the host environment except what -e passes in, plus what the host shell
  // needs to start at all (and PATH, so simple tools like node are found).
  const childEnv = {};
  for (const k of Object.keys(env)) {
    if (['PATH', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR', 'TEMP', 'TMP'].includes(k.toUpperCase())) childEnv[k] = env[k];
  }
  for (const e of [...(flags['-e'] || []), ...(flags['--env'] || [])]) {
    const at = e.indexOf('=');
    if (at > 0) childEnv[e.slice(0, at)] = e.slice(at + 1);
  }

  const child = win
    ? spawn(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd: source, env: childEnv, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'inherit', 'inherit'] })
    : spawn('/bin/sh', ['-c', command], { cwd: source, env: childEnv, detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
  updateState((s) => {
    s.containers[name] = { image, labels, pid: process.pid, childPid: child.pid };
  });
  const code = await new Promise((resolve) => {
    child.on('error', (e) => {
      err(`${flavour}: ${e.message}`);
      resolve(127);
    });
    child.on('close', (c, signal) => resolve(c ?? (signal ? 137 : 1)));
  });
  // --rm: the container is gone once its command ends.
  updateState((s) => {
    delete s.containers[name];
  });
  return code;
}

function cmdKill(names) {
  if (!serverUp) return (cannotConnect(), 1);
  let rc = 0;
  const s = readState();
  for (const name of names) {
    const c = s.containers[name];
    if (!c) {
      err(`Error response from daemon: No such container: ${name}`);
      rc = 1;
      continue;
    }
    delete s.containers[name];
    writeState(s);
    killPids(c);
    out(name);
  }
  return rc;
}

function cmdPs(args) {
  if (!serverUp) return (cannotConnect(), 1);
  const quiet = args.some((a) => /^-[a-z]*q/.test(a) || a === '--quiet');
  const filters = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--filter' || args[i] === '-f') filters.push(args[++i] || '');
    else if (args[i].startsWith('--filter=')) filters.push(args[i].slice('--filter='.length));
  }
  const names = Object.entries(readState().containers)
    .filter(([, c]) =>
      filters.every((f) => {
        if (!f.startsWith('label=')) return true;
        const [k, ...v] = f.slice('label='.length).split('=');
        const labels = c.labels || {};
        return k in labels && (v.length === 0 || labels[k] === v.join('='));
      }),
    )
    .map(([n]) => n);
  if (!quiet) out('NAMES');
  for (const n of names) out(n);
  return 0;
}

function cmdRm(args) {
  if (!serverUp) return (cannotConnect(), 1);
  const ids = args.filter((a) => !a.startsWith('-'));
  if (!ids.length) return (err('"rm" requires at least 1 argument.'), 1);
  let rc = 0;
  const s = readState();
  for (const id of ids) {
    const c = s.containers[id];
    if (!c) {
      err(`Error response from daemon: No such container: ${id}`);
      rc = 1;
      continue;
    }
    delete s.containers[id];
    killPids(c);
    out(id);
  }
  writeState(s);
  return rc;
}

async function main() {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'version':
      return cmdVersion();
    case 'image':
      if (args[0] === 'inspect') return cmdImageInspect(args.slice(1).filter((a) => !a.startsWith('-')));
      break;
    case 'pull':
      return cmdPull(args.find((a) => !a.startsWith('-')));
    case 'run':
      return cmdRun(args);
    case 'kill':
      return cmdKill(args.filter((a) => !a.startsWith('-')));
    case 'ps':
      return cmdPs(args);
    case 'rm':
      return cmdRm(args);
    default:
      break;
  }
  err(`fake runtime: unknown command: ${argv.join(' ')}`);
  return 1;
}

// exitCode, not exit(): let stdout drain into a pipe before the process ends.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    err(`fake runtime: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
