import { mkdtempSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { rolldown } from 'rolldown';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BrokerCall, createServicesServer } from './server';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const textOf = (r: CallToolResult): string => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

async function inProcess(transport: Parameters<typeof createServicesServer>[0], opts = {}): Promise<Client> {
  const server = createServicesServer(transport, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  return client;
}

describe('call_service (in process)', () => {
  it('lists one tool, forwards the call and formats status, headers and body', async () => {
    const calls: BrokerCall[] = [];
    const client = await inProcess(async (c) => {
      calls.push(c);
      return { ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: '{"login":"me"}', truncated: false };
    });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['call_service']);
    const r = (await client.callTool({ name: 'call_service', arguments: { integration: 'github', path: '/user', query: { a: '1' } } })) as CallToolResult;
    expect(calls).toEqual([{ integration: 'github', method: 'GET', path: '/user', query: { a: '1' } }]);
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toBe('HTTP 200\ncontent-type: application/json\n\n{"login":"me"}');
    await client.close();
  });

  it('refusals and HTTP errors come back as tool errors with the reason', async () => {
    const client = await inProcess(async () => ({ ok: false, status: 403, error: "POST needs the user's approval" }));
    const r = (await client.callTool({ name: 'call_service', arguments: { integration: 'github', method: 'POST', path: '/x' } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/refused \(403\).*approval/);
    await client.close();
  });

  it('without a broker every call explains why instead of hanging', async () => {
    const client = await inProcess(null, { unavailableReason: 'the run has no service token' });
    const r = (await client.callTool({ name: 'call_service', arguments: { integration: 'github', path: '/user' } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/no service token/);
    await client.close();
  });
});

describe('the bundled door over stdio (as an AI tool starts it)', () => {
  let tmp: string;
  let bundle: string;
  let broker: Server;
  let url = '';
  const seen: Array<{ auth: string | undefined; body: unknown }> = [];

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'insectoids-services-mcp-'));
    bundle = join(tmp, 'services-mcp.mjs');
    const b = await rolldown({ input: here('./bin/services-mcp.ts'), platform: 'node' });
    await b.write({ file: bundle, format: 'esm' });
    await b.close();
    // A stand-in for the broker: checks the bearer token and echoes the call.
    broker = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        seen.push({ auth: req.headers['authorization'], body: JSON.parse(raw) as unknown });
        const ok = req.headers['authorization'] === 'Bearer run-token';
        res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ok ? { ok: true, status: 200, headers: {}, body: 'hello', truncated: false } : { ok: false, status: 401, error: 'bad token' }));
      });
    });
    await new Promise<void>((resolve) => broker.listen(0, '127.0.0.1', () => resolve()));
    url = `http://127.0.0.1:${(broker.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(async () => {
    await new Promise<void>((resolve) => broker.close(() => resolve()));
    rmSync(tmp, { recursive: true, force: true });
  });

  async function spawnDoor(env: Record<string, string>): Promise<Client> {
    const client = new Client({ name: 'claude-code-stand-in', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [bundle], env, stderr: 'pipe' }));
    return client;
  }

  it('calls the broker with its own token and returns the answer', async () => {
    const client = await spawnDoor({ INSECTOIDS_BROKER_URL: url, INSECTOIDS_BROKER_TOKEN: 'run-token' });
    const r = (await client.callTool({ name: 'call_service', arguments: { integration: 'github', path: '/user' } })) as CallToolResult;
    expect(textOf(r)).toContain('hello');
    expect(seen.at(-1)).toEqual({ auth: 'Bearer run-token', body: { integration: 'github', method: 'GET', path: '/user' } });
    await client.close();
  });

  it('never sends its token to a broker that is not on this computer', async () => {
    const before = seen.length;
    const client = await spawnDoor({ INSECTOIDS_BROKER_URL: 'http://example.com:8080', INSECTOIDS_BROKER_TOKEN: 'run-token' });
    const r = (await client.callTool({ name: 'call_service', arguments: { integration: 'github', path: '/user' } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/not local/);
    expect(seen.length).toBe(before);
    await client.close();
  });
});
