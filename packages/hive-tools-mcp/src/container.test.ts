import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type ContainerPolicy, type HookPolicy, containerNetworkFor } from '@insectoids/reflexes';
import { DEFAULT_CONTAINER_IMAGE } from '@insectoids/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type HiveToolsOptions, createHiveToolsServer } from './index';

/** The stand-in `docker` (no containers): it runs the `sh -c` command on this computer in the --mount source. */
const FAKE = fileURLToPath(new URL('../../workspace/src/fake-runtime.mjs', import.meta.url));

let root: string;
let ws: string;
let outside: string;
const clients: Client[] = [];

beforeAll(() => {
  // Spaces in the path, like the real project folder.
  root = mkdtempSync(join(tmpdir(), 'hive tools container '));
  ws = join(root, 'card workspace');
  outside = join(root, 'other project');
  mkdirSync(ws, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'keep.txt'), 'keep me\n');
});
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  rmSync(join(root, 'log.jsonl'), { force: true });
});

const fakeEnv = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  FAKE_RUNTIME_STATE: join(root, 'state.json'),
  FAKE_RUNTIME_LOG: join(root, 'log.jsonl'),
  FAKE_RUNTIME_IMAGES: DEFAULT_CONTAINER_IMAGE,
  ...over,
});

const containerPolicy = (over: Partial<ContainerPolicy> = {}): ContainerPolicy => ({
  runtime: 'docker',
  command: process.execPath,
  commandArgs: [FAKE],
  image: DEFAULT_CONTAINER_IMAGE,
  // A documentation-only caste: no network inside a container (the user's decision).
  network: containerNetworkFor('docs'),
  cpus: 1,
  memoryMb: 1024,
  pidsLimit: 128,
  name: 'insectoids-g-1-c-07-test',
  ...over,
});

const policy = (over: Partial<ContainerPolicy> = {}): HookPolicy => ({ workspace: ws, home: join(root, 'home'), network: 'docs', container: containerPolicy(over) });

async function connect(p: HookPolicy, opts: HiveToolsOptions = {}): Promise<Client> {
  const server = createHiveToolsServer(p, { env: fakeEnv(), ...opts });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'engine-stand-in', version: '1.0.0' });
  await client.connect(b);
  clients.push(client);
  return client;
}

const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = (await c.callTool({ name, arguments: args })) as CallToolResult;
  return { error: r.isError === true, text: r.content.map((x) => (x.type === 'text' ? x.text : '')).join('\n') };
};
const runs = (): string[][] =>
  existsSync(join(root, 'log.jsonl'))
    ? readFileSync(join(root, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[])
    : [];

describe('run_shell in container mode', () => {
  it('describes sh in a Linux container with the worktree at /work', async () => {
    const c = await connect(policy());
    const tool = (await c.listTools()).tools.find((t) => t.name === 'run_shell')!;
    expect(tool.description).toMatch(/sh command inside a throwaway Linux container/);
    expect(tool.description).toMatch(/mounted at \/work/);
    expect(tool.description).not.toMatch(/PowerShell/);
    expect(c.getInstructions()).toMatch(/run_shell runs sh inside a Linux container/);
  });

  it('runs the command through the runtime; writes in /work land in the worktree', async () => {
    const c = await connect(policy());
    const r = await call(c, 'run_shell', { command: 'echo hi > out.txt' });
    expect(r.error).toBe(false);
    expect(r.text).toMatch(/^Exit code 0/);
    expect(readFileSync(join(ws, 'out.txt'), 'utf8')).toMatch(/^hi/);
    const [argv] = runs();
    expect(argv).toBeDefined();
    expect(argv!.slice(0, 4)).toEqual(['run', '--rm', '-i', '--name']);
    expect(argv![4]).toMatch(/^insectoids-g-1-c-07-test-\d+$/);
    // The docs caste gets no network in a container; every security flag is there.
    expect(argv![argv!.indexOf('--network') + 1]).toBe('none');
    for (const flag of ['--read-only', '--cap-drop', '--security-opt', '--pids-limit', '--memory', '--memory-swap', '--cpus']) expect(argv).toContain(flag);
    expect(argv).toContain(`type=bind,source=${ws},target=/work`);
    // Only HOME goes in (npm's cache needs a writable home); nothing from the host environment.
    expect(argv!.filter((a, i) => argv![i - 1] === '-e')).toEqual(['HOME=/tmp']);
    expect(argv!.slice(-4)).toEqual([DEFAULT_CONTAINER_IMAGE, 'sh', '-c', 'echo hi > out.txt']);
  });

  it('numbers each container and hands back the command\'s own exit code', async () => {
    const c = await connect(policy());
    await call(c, 'run_shell', { command: 'echo one' });
    const fail = await call(c, 'run_shell', { command: 'node -e "process.exit(3)"' });
    expect(fail.error).toBe(false);
    expect(fail.text).toContain('Exit code 3');
    // Numbered one after another from a random start, so a restarted server can't reuse a live container's name.
    const [first, second] = runs().map((a) => a[a.indexOf('--name') + 1]!);
    const n = Number(/-(\d+)$/.exec(first!)![1]);
    expect(first).toBe(`insectoids-g-1-c-07-test-${n}`);
    expect(second).toBe(`insectoids-g-1-c-07-test-${n + 1}`);
  });

  it('judges a command as it runs in the container: /work paths are the workspace, also on Windows', async () => {
    const c = await connect({ ...policy(), platform: 'win32' });
    const r = await call(c, 'run_shell', { command: 'echo hi > /work/inside.txt' });
    expect(r.text).not.toMatch(/Blocked by the Insectoids guard/);
    expect(runs()).toHaveLength(1);
  });

  it("the container's own /tmp is throwaway scratch space: writing there reaches the runtime, deleting /tmp itself doesn't", async () => {
    const c = await connect(policy());
    // The folder doesn't exist, so the fake runtime (which runs commands on this computer) writes nothing.
    const w = await call(c, 'run_shell', { command: 'echo x > /tmp/insectoids-no-such-dir/before.json' });
    expect(w.text).not.toMatch(/Blocked by the Insectoids guard/);
    expect(runs()).toHaveLength(1);
    const rm = await call(c, 'run_shell', { command: 'rm -rf /tmp' });
    expect(rm.text).toMatch(/Blocked by the Insectoids guard/);
    expect(runs()).toHaveLength(1);
  });

  it('the command guard still runs first, judged as inside the container: escaping /work never reaches the runtime', async () => {
    const c = await connect(policy());
    // Inside the container the computer's folders don't exist; what matters is leaving the worktree there.
    for (const command of ['rm -rf /work/..', 'rm -rf /']) {
      const rm = await call(c, 'run_shell', { command });
      expect(rm.error, command).toBe(true);
      expect(rm.text).toMatch(/Blocked by the Insectoids guard/);
    }
    expect(runs()).toEqual([]);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });

  it('a timeout stops the container by name, and everything in it', async () => {
    const c = await connect(policy());
    const started = Date.now();
    const r = await call(c, 'run_shell', {
      command: `node -e "require('fs').writeFileSync('child.pid', String(process.pid)); setTimeout(() => {}, 60000)"`,
      timeout_ms: 2000,
    });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/Timed out after 2000 ms; the container \(insectoids-g-1-c-07-test-\d+\)/);
    const name = /\((insectoids-g-1-c-07-test-\d+)\)/.exec(r.text)![1]!;
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(runs()).toContainEqual(['kill', name]);
    const pid = Number(readFileSync(join(ws, 'child.pid'), 'utf8'));
    await new Promise((res) => setTimeout(res, 500));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('when the runtime program is missing, says so in plain words and runs nothing on the computer', async () => {
    const c = await connect(policy({ command: join(root, 'no-such-docker.exe'), commandArgs: [] }));
    const r = await call(c, 'run_shell', { command: 'echo leaked > host.txt' });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/^Docker isn't running/);
    expect(r.text).toMatch(/never run on the computer/);
    expect(existsSync(join(ws, 'host.txt'))).toBe(false);
  });

  it('when the runtime\'s service is down, says so (Podman too)', async () => {
    const down = await call(await connect(policy(), { env: fakeEnv({ FAKE_RUNTIME_SERVER: 'down' }) }), 'run_shell', { command: 'echo x > down.txt' });
    expect(down.error).toBe(true);
    expect(down.text).toMatch(/^Docker isn't running/);
    const podman = await call(await connect(policy({ runtime: 'podman' }), { env: fakeEnv({ FAKE_RUNTIME_SERVER: 'down', FAKE_RUNTIME_FLAVOR: 'podman' }) }), 'run_shell', { command: 'echo x > down.txt' });
    expect(podman.text).toMatch(/^Podman isn't running/);
    expect(existsSync(join(ws, 'down.txt'))).toBe(false);
  });

  it('when the image is not on this computer, says so and never pulls it', async () => {
    const c = await connect(policy(), { env: fakeEnv({ FAKE_RUNTIME_IMAGES: '' }) });
    const r = await call(c, 'run_shell', { command: 'echo x > noimage.txt' });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/image .* isn't on this computer yet/);
    expect(runs().some((a) => a[0] === 'pull')).toBe(false);
    expect(runs()[0]).toEqual(expect.arrayContaining(['--pull', 'never']));
    expect(existsSync(join(ws, 'noimage.txt'))).toBe(false);
  });

  it('an unusable container policy refuses in plain words', async () => {
    const c = await connect(policy({ image: 'node:22 --privileged' }));
    const r = await call(c, 'run_shell', { command: 'echo x' });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/Container mode can't run this command: .*isn't an image name/);
    expect(runs()).toEqual([]);
  });
});
