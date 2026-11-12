import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { rolldown } from 'rolldown';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
let tmp: string;
let ws: string;
let bundlePath: string;
const clients: Client[] = [];

// The same single-file bundle the app ships (pnpm --filter @insectoids/hive-tools-mcp build).
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'hive tools stdio '));
  ws = join(tmp, 'card ws');
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, '.env'), 'TOKEN=abc\n');
  bundlePath = join(tmp, 'hive-tools-mcp.mjs');
  const bundle = await rolldown({ input: here('./bin/hive-tools-mcp.ts'), platform: 'node' });
  await bundle.write({ file: bundlePath, format: 'esm' });
  await bundle.close();
}, 60_000);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
});

/** Start the bundle the way Gemini CLI does: a child process speaking MCP on stdio. */
async function spawnTools(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [bundlePath], env, stderr: 'pipe' });
  const client = new Client({ name: 'gemini-stand-in', version: '1.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const textOf = (r: unknown): string => (r as CallToolResult).content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

describe('the bundled hive tools over stdio', () => {
  it('an insect writes and reads through the guard; secrets stay blocked', async () => {
    const guard = JSON.stringify({ workspace: ws, home: join(tmp, 'home'), network: 'none' });
    const mcp = await spawnTools({ INSECTOIDS_GUARD: guard, PATH: process.env['PATH'] ?? '', SYSTEMROOT: process.env['SYSTEMROOT'] ?? '' });
    expect(mcp.getServerVersion()?.name).toBe('insectoids-hive-tools');
    expect(textOf(await mcp.callTool({ name: 'write_file', arguments: { path: 'hello.txt', content: 'hi' } }))).toMatch(/Wrote hello.txt/);
    expect(readFileSync(join(ws, 'hello.txt'), 'utf8')).toBe('hi');
    expect(textOf(await mcp.callTool({ name: 'read_file', arguments: { path: 'hello.txt' } }))).toBe('hi');
    const secret = (await mcp.callTool({ name: 'read_file', arguments: { path: '.env' } })) as CallToolResult;
    expect(secret.isError).toBe(true);
    expect(textOf(secret)).toMatch(/protected-path/);
  });

  it('without a policy it still starts, and refuses everything', async () => {
    const mcp = await spawnTools({ PATH: process.env['PATH'] ?? '' });
    const r = (await mcp.callTool({ name: 'write_file', arguments: { path: 'nope.txt', content: 'x' } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/no policy/);
    expect(existsSync(join(ws, 'nope.txt'))).toBe(false);
  });
});
