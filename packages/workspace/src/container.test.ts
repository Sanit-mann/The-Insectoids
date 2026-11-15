import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContainerPolicy } from '@insectoids/reflexes';
import { DEFAULT_CONTAINER_IMAGE } from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunFn, containerRunArgs, detectContainerRuntime, imagePresent, killContainer, pullImage, removeLeftovers, removeRunContainers } from './container';

const FAKE = fileURLToPath(new URL('./fake-runtime.mjs', import.meta.url));
const fakeRt = { command: process.execPath, commandArgs: [FAKE] };

const policy = (over: Partial<ContainerPolicy> = {}): ContainerPolicy => ({
  runtime: 'docker',
  command: 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
  image: DEFAULT_CONTAINER_IMAGE,
  network: 'none',
  cpus: 2,
  memoryMb: 2048,
  pidsLimit: 256,
  name: 'insectoids-g-1-c-01-ab12',
  ...over,
});

describe('containerRunArgs: one throwaway container per command', () => {
  it('builds the exact argv, with every security flag, for a Windows path with spaces', () => {
    const ws = 'C:\\Users\\Sam Smith\\AppData\\Local\\The Insectoids\\worktrees\\G-1\\C-01';
    expect(containerRunArgs(policy(), { workspace: ws, command: 'npm test && echo "done"', index: 3 })).toEqual([
      'run', '--rm', '-i',
      '--name', 'insectoids-g-1-c-01-ab12-3',
      '--label', 'io.insectoids.run=insectoids-g-1-c-01-ab12',
      '--pull', 'never',
      '--network', 'none',
      '--cpus', '2',
      '--memory', '2048m',
      '--memory-swap', '2048m',
      '--pids-limit', '256',
      '--read-only',
      '--tmpfs', '/tmp:rw,size=256m',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--mount', `type=bind,source=${ws},target=/work`,
      '-w', '/work',
      DEFAULT_CONTAINER_IMAGE,
      'sh', '-c', 'npm test && echo "done"',
    ]);
  });

  it('open network becomes bridge; fractional CPUs pass through', () => {
    const args = containerRunArgs(policy({ network: 'open', cpus: 0.5 }), { workspace: '/home/sam/wt', command: 'ls', index: 1 });
    expect(args[args.indexOf('--network') + 1]).toBe('bridge');
    expect(args[args.indexOf('--cpus') + 1]).toBe('0.5');
    expect(args).not.toContain('-v');
  });

  it('Podman keeps the user id so files written in /work belong to the user; Docker does not get the flag', () => {
    expect(containerRunArgs(policy({ runtime: 'podman' }), { workspace: '/w', command: 'ls', index: 1 })).toContain('--userns=keep-id');
    expect(containerRunArgs(policy(), { workspace: '/w', command: 'ls', index: 1 })).not.toContain('--userns=keep-id');
    // Docker on Linux: run as the user (uid:gid) so files in /work stay theirs; anything else is refused.
    const asUser = containerRunArgs(policy(), { workspace: '/w', command: 'ls', index: 1, user: '1000:1000' });
    expect(asUser.slice(asUser.indexOf('--user'), asUser.indexOf('--user') + 2)).toEqual(['--user', '1000:1000']);
    expect(asUser.indexOf('--user')).toBeLessThan(asUser.indexOf(policy().image));
    expect(() => containerRunArgs(policy(), { workspace: '/w', command: 'ls', index: 1, user: 'root; rm' })).toThrow(/uid:gid/);
  });

  it('passes only the variables it is given, never the host environment', () => {
    process.env['INSECTOIDS_TEST_SECRET'] = 'leak';
    try {
      const none = containerRunArgs(policy(), { workspace: '/w', command: 'env', index: 1 });
      expect(none).not.toContain('-e');
      expect(none.join(' ')).not.toContain('leak');
      const some = containerRunArgs(policy(), { workspace: '/w', command: 'env', index: 1, env: { HOME: '/tmp', CI: '1' } });
      expect(some.filter((a, i) => some[i - 1] === '-e')).toEqual(['HOME=/tmp', 'CI=1']);
      // The variables come before the image, so they are flags, not part of the command.
      expect(some.indexOf('-e')).toBeLessThan(some.indexOf(DEFAULT_CONTAINER_IMAGE));
    } finally {
      delete process.env['INSECTOIDS_TEST_SECRET'];
    }
  });

  it('refuses, in plain words, anything the runtime could misread', () => {
    const run = (p: Partial<ContainerPolicy>, workspace = '/w', env?: Record<string, string>) => () =>
      containerRunArgs(policy(p), { workspace, command: 'ls', index: 1, ...(env ? { env } : {}) });
    expect(run({}, 'C:\\work,readonly=false')).toThrow(/comma or a line break/);
    expect(run({}, '/home/sam/a\nb')).toThrow(/comma or a line break/);
    expect(run({}, 'relative/folder')).toThrow(/full path/);
    expect(run({ image: 'node:22 --privileged' })).toThrow(/isn.t an image name/);
    expect(run({ image: '--privileged' })).toThrow(/isn.t an image name/);
    expect(run({ image: 'Node:22' })).toThrow(/isn.t an image name/);
    expect(run({ name: 'Bad_Name' })).toThrow(/lowercase letters, digits and dashes/);
    expect(run({ name: '-x' })).toThrow(/lowercase letters, digits and dashes/);
    expect(run({ name: 'a b' })).toThrow(/lowercase letters, digits and dashes/);
    expect(run({ cpus: 0 })).toThrow(/positive number/);
    expect(run({}, '/w', { 'BAD-KEY': 'x' })).toThrow(/variable name/);
    expect(() => containerRunArgs(policy(), { workspace: '/w', command: 'ls', index: -1 })).toThrow(/whole number/);
  });
});

describe('detectContainerRuntime: Docker first, then Podman, real executables only', () => {
  const dockerJson = (server: boolean) =>
    JSON.stringify({ Client: { Platform: { Name: '' }, Version: '27.3.1', ApiVersion: '1.47' }, Server: server ? { Version: '27.3.0' } : null });
  const podmanJson = JSON.stringify({ Client: { APIVersion: '5.2.0', Version: '5.2.0', OsArch: 'linux/amd64' } });

  /** A fake PATH and fake programs: no process is started. */
  function setup(files: string[], answers: Record<string, { code: number; stdout: string }>) {
    const calls: Array<[string, string[]]> = [];
    const run: RunFn = async (cmd, args) => {
      calls.push([cmd, args]);
      const a = answers[cmd];
      return a ? { ...a, stderr: '' } : { code: null, stdout: '', stderr: 'ENOENT' };
    };
    return { calls, o: { platform: 'win32' as const, env: { Path: 'C:\\Tools;C:\\Docker\\bin;C:\\Podman' }, exists: (p: string) => files.includes(p), run } };
  }

  it('finds a running Docker', async () => {
    const s = setup(['C:\\Docker\\bin\\docker.exe'], { 'C:\\Docker\\bin\\docker.exe': { code: 0, stdout: dockerJson(true) } });
    expect(await detectContainerRuntime(s.o)).toEqual({ kind: 'docker', command: 'C:\\Docker\\bin\\docker.exe', commandArgs: [], version: '27.3.0', running: true });
    expect(s.calls).toEqual([['C:\\Docker\\bin\\docker.exe', ['version', '--format', 'json']]]);
  });

  it('a Docker client whose service is not answering is found but not running', async () => {
    const s = setup(['C:\\Docker\\bin\\docker.exe'], { 'C:\\Docker\\bin\\docker.exe': { code: 1, stdout: dockerJson(false) } });
    expect(await detectContainerRuntime(s.o)).toMatchObject({ kind: 'docker', running: false, version: '27.3.1' });
  });

  it('prefers a running Podman over a Docker that is not answering', async () => {
    const s = setup(['C:\\Docker\\bin\\docker.exe', 'C:\\Podman\\podman.exe'], {
      'C:\\Docker\\bin\\docker.exe': { code: 1, stdout: dockerJson(false) },
      'C:\\Podman\\podman.exe': { code: 0, stdout: podmanJson },
    });
    expect(await detectContainerRuntime(s.o)).toMatchObject({ kind: 'podman', command: 'C:\\Podman\\podman.exe', running: true });
  });

  it('finds Podman when it is the only runtime', async () => {
    const s = setup(['C:\\Podman\\podman.exe'], { 'C:\\Podman\\podman.exe': { code: 0, stdout: podmanJson } });
    expect(await detectContainerRuntime(s.o)).toEqual({ kind: 'podman', command: 'C:\\Podman\\podman.exe', commandArgs: [], version: '5.2.0', running: true });
  });

  it('returns null when there is nothing, and never starts anything to look', async () => {
    const s = setup([], {});
    expect(await detectContainerRuntime(s.o)).toBeNull();
    expect(s.calls).toEqual([]);
  });

  it('never picks a .cmd or .bat (they would go through cmd.exe), even earlier on PATH', async () => {
    const onlyCmd = setup(['C:\\Tools\\docker.cmd', 'C:\\Tools\\podman.bat'], {});
    expect(await detectContainerRuntime(onlyCmd.o)).toBeNull();
    expect(onlyCmd.calls).toEqual([]);
    const both = setup(['C:\\Tools\\docker.cmd', 'C:\\Docker\\bin\\docker.exe'], { 'C:\\Docker\\bin\\docker.exe': { code: 0, stdout: dockerJson(true) } });
    expect((await detectContainerRuntime(both.o))?.command).toBe('C:\\Docker\\bin\\docker.exe');
  });

  it('on Linux and macOS looks for plain names, and skips relative PATH entries', async () => {
    const calls: string[] = [];
    const found = await detectContainerRuntime({
      platform: 'linux',
      env: { PATH: 'bin:/usr/local/bin:/usr/bin' },
      exists: (p) => p === '/usr/bin/podman' || p === 'bin/docker',
      run: async (cmd) => (calls.push(cmd), { code: 0, stdout: podmanJson, stderr: '' }),
    });
    expect(found).toMatchObject({ kind: 'podman', command: '/usr/bin/podman' });
    expect(calls).toEqual(['/usr/bin/podman']);
  });

  it('a `docker` that is really Podman (its docker shim) is reported as Podman', async () => {
    const found = await detectContainerRuntime({
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      exists: (p) => p === '/usr/bin/docker',
      run: async () => ({ code: 0, stdout: podmanJson, stderr: '' }),
    });
    expect(found).toMatchObject({ kind: 'podman', command: '/usr/bin/docker' });
  });
});

describe('on the fake runtime (no containers)', () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'insectoids fake runtime '));
    env = { ...process.env, FAKE_RUNTIME_STATE: join(tmp, 'state.json'), FAKE_RUNTIME_LOG: join(tmp, 'log.jsonl') };
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const log = (): string[][] => readFileSync(join(tmp, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);

  it('detects it through the override, in each flavour and state', async () => {
    const override = { command: process.execPath, commandArgs: [FAKE] };
    expect(await detectContainerRuntime({ env, override })).toEqual({ kind: 'docker', command: process.execPath, commandArgs: [FAKE], version: '27.3.1', running: true });
    expect(await detectContainerRuntime({ env: { ...env, FAKE_RUNTIME_SERVER: 'down' }, override })).toMatchObject({ kind: 'docker', running: false });
    expect(await detectContainerRuntime({ env: { ...env, FAKE_RUNTIME_FLAVOR: 'podman' }, override })).toMatchObject({ kind: 'podman', running: true, version: '5.2.0' });
    expect(await detectContainerRuntime({ env: { ...env, FAKE_RUNTIME_FLAVOR: 'podman', FAKE_RUNTIME_SERVER: 'down' }, override })).toMatchObject({ kind: 'podman', running: false });
  });

  it('a runtime program that does not exist is not found', async () => {
    expect(await detectContainerRuntime({ env, override: { command: join(tmp, 'no-such-docker.exe'), commandArgs: [] } })).toBeNull();
  });

  it('pulls an image only when asked, with progress lines, then finds it', async () => {
    expect(await imagePresent(fakeRt, DEFAULT_CONTAINER_IMAGE, { env })).toBe(false);
    const lines: string[] = [];
    const pull = pullImage(fakeRt, DEFAULT_CONTAINER_IMAGE, (l) => lines.push(l), { env });
    expect(await pull.done).toEqual({ ok: true });
    expect(lines.some((l) => /Downloading\s+20MB\/40MB/.test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(/Downloaded newer image/);
    expect(await imagePresent(fakeRt, DEFAULT_CONTAINER_IMAGE, { env })).toBe(true);
    expect(log().map((a) => a[0])).toEqual(['image', 'pull', 'image']);
  });

  it('a failed pull says why; a stopped pull says so', async () => {
    const failed = await pullImage(fakeRt, 'node:22', () => {}, { env: { ...env, FAKE_RUNTIME_PULL: 'fail' } }).done;
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/manifest unknown/);
    const slow = pullImage(fakeRt, 'node:22', () => {}, { env: { ...env, FAKE_RUNTIME_PULL: 'slow' } });
    setTimeout(() => slow.stop(), 300);
    expect(await slow.done).toEqual({ ok: false, error: 'The download was stopped.' });
    expect(await imagePresent(fakeRt, 'node:22', { env })).toBe(false);
  });

  it('removeLeftovers removes only the hive-labelled containers and counts them', async () => {
    writeFileSync(
      join(tmp, 'state.json'),
      JSON.stringify({
        images: [],
        containers: {
          'insectoids-g-1-c-01-x-1': { labels: { 'io.insectoids.run': 'insectoids-g-1-c-01-x' } },
          'insectoids-g-1-c-02-y-4': { labels: { 'io.insectoids.run': 'insectoids-g-1-c-02-y' } },
          'users-own-db': { labels: { 'com.example': 'db' } },
        },
      }),
    );
    expect(await removeLeftovers(fakeRt, { env })).toBe(2);
    const state = JSON.parse(readFileSync(join(tmp, 'state.json'), 'utf8')) as { containers: Record<string, unknown> };
    expect(Object.keys(state.containers)).toEqual(['users-own-db']);
    expect(log()).toEqual([
      ['ps', '-aq', '--filter', 'label=io.insectoids.run'],
      ['rm', '-f', 'insectoids-g-1-c-01-x-1', 'insectoids-g-1-c-02-y-4'],
    ]);
    expect(await removeLeftovers(fakeRt, { env })).toBe(0);
  });

  it('removeRunContainers removes only one run’s containers', async () => {
    writeFileSync(
      join(tmp, 'state.json'),
      JSON.stringify({
        images: [],
        containers: {
          'insectoids-g-1-c-01-x-1': { labels: { 'io.insectoids.run': 'insectoids-g-1-c-01-x' } },
          'insectoids-g-1-c-01-x-2': { labels: { 'io.insectoids.run': 'insectoids-g-1-c-01-x' } },
          'insectoids-g-1-c-02-y-4': { labels: { 'io.insectoids.run': 'insectoids-g-1-c-02-y' } },
        },
      }),
    );
    expect(await removeRunContainers(fakeRt, 'insectoids-g-1-c-01-x', { env })).toBe(2);
    const state = JSON.parse(readFileSync(join(tmp, 'state.json'), 'utf8')) as { containers: Record<string, unknown> };
    expect(Object.keys(state.containers)).toEqual(['insectoids-g-1-c-02-y-4']);
    expect(await removeRunContainers(fakeRt, 'bad name; rm', { env })).toBe(0);
  });

  it('killContainer stops one container by name and shrugs off one that is already gone', async () => {
    writeFileSync(join(tmp, 'state.json'), JSON.stringify({ images: [], containers: { 'run-a-1': { labels: {} }, 'run-a-2': { labels: {} } } }));
    await killContainer(fakeRt, 'run-a-1', { env });
    await killContainer(fakeRt, 'run-a-9', { env });
    const state = JSON.parse(readFileSync(join(tmp, 'state.json'), 'utf8')) as { containers: Record<string, unknown> };
    expect(Object.keys(state.containers)).toEqual(['run-a-2']);
    expect(log()).toEqual([['kill', 'run-a-1'], ['kill', 'run-a-9'], ['rm', '-f', 'run-a-9']]);
    expect(existsSync(join(tmp, 'state.json'))).toBe(true);
  });
});
