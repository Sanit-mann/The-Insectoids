import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { HookPolicy } from '@insectoids/reflexes';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type HiveToolsOptions, createHiveToolsServer } from './index';

let root: string;
let ws: string;
let outside: string;
const clients: Client[] = [];

beforeAll(() => {
  // A space in the path, like the real project folder.
  root = mkdtempSync(join(tmpdir(), 'hive tools '));
  ws = join(root, 'card workspace');
  outside = join(root, 'other project');
  mkdirSync(join(ws, 'src'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(ws, 'src', 'index.js'), 'export const a = 1;\nexport const b = 2;\n');
  writeFileSync(join(ws, 'README.md'), '# Demo\nhello world\n');
  writeFileSync(join(ws, '.env'), 'API_KEY=supersecret\n');
  writeFileSync(join(outside, 'keep.txt'), 'keep me\n');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
});

const policy = (over: Partial<HookPolicy> = {}): HookPolicy => ({ workspace: ws, home: join(root, 'home'), network: 'none', ...over });

async function connect(p: HookPolicy | null, opts: HiveToolsOptions = {}): Promise<Client> {
  const server = createHiveToolsServer(p, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'gemini-stand-in', version: '1.0.0' });
  await client.connect(b);
  clients.push(client);
  return client;
}

const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = (await c.callTool({ name, arguments: args })) as CallToolResult;
  return { error: r.isError === true, text: r.content.map((x) => (x.type === 'text' ? x.text : '')).join('\n') };
};

describe('the tools work inside the workspace', () => {
  it('lists the seven tools', async () => {
    const c = await connect(policy());
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(['edit_file', 'glob', 'list_dir', 'read_file', 'run_shell', 'search', 'write_file']);
  });

  it('reads, lists, globs and searches', async () => {
    const c = await connect(policy());
    expect((await call(c, 'read_file', { path: 'src/index.js' })).text).toContain('export const a = 1;');
    expect((await call(c, 'read_file', { path: 'src/index.js', offset: 2, limit: 1 })).text).toMatch(/lines 2-2 of \d+\)\nexport const b = 2;/);
    expect((await call(c, 'list_dir', {})).text.split('\n')).toEqual(expect.arrayContaining(['README.md', 'src/']));
    expect((await call(c, 'glob', { pattern: '**/*.js' })).text).toBe('src/index.js');
    const found = await call(c, 'search', { pattern: 'hello', literal: true });
    expect(found.text).toContain('README.md:2: hello world');
  });

  it('writes and edits files', async () => {
    const c = await connect(policy());
    expect((await call(c, 'write_file', { path: 'out/new.txt', content: 'one two two' })).error).toBe(false);
    expect(readFileSync(join(ws, 'out', 'new.txt'), 'utf8')).toBe('one two two');
    expect((await call(c, 'edit_file', { path: 'out/new.txt', old_string: 'two', new_string: 'x' })).text).toMatch(/matches 2 times/);
    expect((await call(c, 'edit_file', { path: 'out/new.txt', old_string: 'two', new_string: 'x', replace_all: true })).error).toBe(false);
    expect(readFileSync(join(ws, 'out', 'new.txt'), 'utf8')).toBe('one x x');
    expect((await call(c, 'edit_file', { path: 'out/new.txt', old_string: 'missing', new_string: 'y' })).error).toBe(true);
  });

  it('says in plain words when a path cannot take a file (a file where a folder should be, or a folder)', async () => {
    const c = await connect(policy());
    await call(c, 'write_file', { path: 'docs/examples', content: 'oops, a file' });
    const inside = await call(c, 'write_file', { path: 'docs/examples/wordcount.md', content: '# x' });
    expect(inside.error).toBe(true);
    expect(inside.text).toMatch(/docs\/examples is a file/);
    expect(inside.text).not.toMatch(/EEXIST/);
    const folder = await call(c, 'write_file', { path: 'src', content: 'x' });
    expect(folder.error).toBe(true);
    expect(folder.text).toMatch(/src is a folder/);
  });

  it('runs a shell command and reports a non-zero exit as a normal result', async () => {
    const c = await connect(policy());
    const ok = await call(c, 'run_shell', { command: 'node --version' });
    expect(ok.error).toBe(false);
    expect(ok.text).toMatch(/Exit code 0[\s\S]*v\d+\./);
    const fail = await call(c, 'run_shell', { command: 'node -e "process.exit(3)"' });
    expect(fail.error).toBe(false);
    expect(fail.text).toContain('Exit code 3');
  });
});

describe('the guard runs before every action (fails closed)', () => {
  it('never reads secrets, by any tool', async () => {
    const c = await connect(policy());
    const r = await call(c, 'read_file', { path: '.env' });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/Blocked by the Insectoids guard \[protected-path\]/);
    expect((await call(c, 'glob', { pattern: '*' })).text).not.toContain('.env');
    const s = await call(c, 'search', { pattern: 'supersecret', literal: true });
    expect(s.text).toContain('No matches.');
    expect(s.text).toMatch(/protected file\(s\) skipped/);
  });

  it('never touches anything outside the workspace', async () => {
    const c = await connect(policy());
    for (const [tool, args] of [
      ['read_file', { path: '../other project/keep.txt' }],
      ['write_file', { path: join(outside, 'evil.txt'), content: 'x' }],
      ['list_dir', { path: '..' }],
      ['glob', { pattern: '../**/*' }],
    ] as const) {
      const r = await call(c, tool, args);
      expect(r.error, tool).toBe(true);
      expect(r.text, tool).toMatch(/outside/);
    }
    expect(existsSync(join(outside, 'evil.txt'))).toBe(false);
  });

  it('blocks deleting outside the workspace, and commits (the hive commits)', async () => {
    const c = await connect(policy());
    const rm = await call(c, 'run_shell', { command: `rm -rf "${outside}"` });
    expect(rm.error).toBe(true);
    expect(rm.text).toMatch(/Blocked by the Insectoids guard/);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    const commit = await call(c, 'run_shell', { command: 'git commit -m "x"' });
    expect(commit.text).toMatch(/\[hive-commits\]/);
  });

  it('a push needs approval, and runs once the user approved that rule for the card', async () => {
    const asked = await call(await connect(policy()), 'run_shell', { command: 'git push origin main' });
    expect(asked.error).toBe(true);
    expect(asked.text).toMatch(/Needs the user's approval \[push\][\s\S]*STATUS: BLOCKED/);
    const approved = await call(await connect(policy({ approvedRules: ['push'] })), 'run_shell', { command: 'git push origin main' });
    // Allowed by the guard; git itself fails (no repository here), which is a normal result.
    expect(approved.text).not.toMatch(/Needs the user's approval/);
    expect(approved.text).toMatch(/Exit code \d+/);
  });

  it('with no policy, every tool refuses', async () => {
    const c = await connect(null);
    for (const [tool, args] of [
      ['read_file', { path: 'README.md' }],
      ['list_dir', {}],
      ['write_file', { path: 'a.txt', content: 'x' }],
      ['run_shell', { command: 'node --version' }],
    ] as const) {
      const r = await call(c, tool, args);
      expect(r.error, tool).toBe(true);
      expect(r.text, tool).toMatch(/no policy/);
    }
    expect(existsSync(join(ws, 'a.txt'))).toBe(false);
  });
});

describe('shell hygiene', () => {
  it('commands never see ELECTRON_RUN_AS_NODE, the guard policy or the Brain token', async () => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', INSECTOIDS_GUARD: '{"x":1}', INSECTOIDS_BRAIN_TOKEN: 'tok', KEEP_ME: 'yes' };
    const c = await connect(policy(), { env });
    const r = await call(c, 'run_shell', {
      command: `node -e "console.log([process.env.ELECTRON_RUN_AS_NODE, process.env.INSECTOIDS_GUARD, process.env.INSECTOIDS_BRAIN_TOKEN, process.env.KEEP_ME].join('|'))"`,
    });
    expect(r.text).toContain('|||yes');
  });

  it('a timeout stops the command and everything it started', async () => {
    const c = await connect(policy());
    const pidFile = join(ws, 'child.pid');
    const started = Date.now();
    const r = await call(c, 'run_shell', {
      command: `node -e "require('fs').writeFileSync('child.pid', String(process.pid)); setTimeout(() => {}, 60000)"`,
      timeout_ms: 2000,
    });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/Timed out after 2000 ms/);
    expect(Date.now() - started).toBeLessThan(20_000);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    // The grandchild (node, started by the shell) is gone too.
    await new Promise((res) => setTimeout(res, 500));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
