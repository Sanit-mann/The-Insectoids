import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type Brain, openBrain } from '@insectoids/brain';
import { BrainClient, BrainServiceError, type BrainService, startBrainService } from '@insectoids/brain-service';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BrainAccess, clientAccess, createBrainMcpServer, unavailableAccess } from './index';

const READ_TOOLS = ['brain_boot_card', 'brain_get', 'brain_history', 'brain_links', 'brain_read', 'brain_search'];
const WRITE_TOOLS = ['brain_archive', 'brain_link', 'brain_update', 'brain_write'];
const user = { type: 'user' } as const;

let brain: Brain;
let service: BrainService;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(async () => {
  brain = openBrain(':memory:');
  service = await startBrainService({ brain });
});

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await service.close();
  brain.close();
});

async function mcpWith(source: BrainClient | BrainAccess, opts: Parameters<typeof createBrainMcpServer>[1] = {}): Promise<Client> {
  const server = createBrainMcpServer(source, opts);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-insect', version: '1.0.0' });
  await client.connect(clientSide);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function mcpFor(token: string): Promise<Client> {
  const bc = await BrainClient.connect({ endpoint: service.endpoint, token });
  cleanups.push(() => bc.close());
  return mcpWith(bc);
}

const agent = (o: { write?: boolean; shelf?: string; agentId?: string } = {}) =>
  mcpFor(service.issueAgentToken({ agentId: o.agentId ?? 'Ant-07', shelf: o.shelf ?? 'site', write: o.write ?? true }));

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  return { text, isError: r.isError === true };
}

const toolNames = async (client: Client) => (await client.listTools()).tools.map((t) => t.name).sort();
const idIn = (text: string): string => /Saved as ([\w-]+)/.exec(text)?.[1] ?? '';

describe('tool listing', () => {
  it('a read-only insect only sees read tools; a writer sees all ten', async () => {
    expect(await toolNames(await agent({ write: false }))).toEqual(READ_TOOLS);
    expect(await toolNames(await agent())).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
  });

  it('agents are never offered a shelf argument; the app (user) is', async () => {
    const tools = (await (await agent()).listTools()).tools;
    for (const t of tools) expect(Object.keys(t.inputSchema.properties ?? {})).not.toContain('shelf');
    const userTools = (await (await mcpFor(service.masterToken)).listTools()).tools;
    expect(Object.keys(userTools.find((t) => t.name === 'brain_search')!.inputSchema.properties ?? {})).toContain('shelf');
  });

  it('read tools are marked read-only and the instructions match the access', async () => {
    const reader = await agent({ write: false });
    const search = (await reader.listTools()).tools.find((t) => t.name === 'brain_search')!;
    expect(search.annotations?.readOnlyHint).toBe(true);
    expect(reader.getInstructions()).toMatch(/read-only/);
    expect((await agent()).getInstructions()).toMatch(/Search before writing/);
  });
});

describe('an insect reads and writes the Brain through MCP', () => {
  it('write, then search, read, get, boot card', async () => {
    const ant = await agent();
    const saved = await call(ant, 'brain_write', { kind: 'fact', title: 'Brand font', body: 'The site uses Satoshi for headings.' });
    expect(saved).toMatchObject({ isError: false });
    expect(saved.text).toMatch(/^Saved as [\w-]+ \(trust: unconfirmed\)\.$/);
    const id = idIn(saved.text);
    expect(brain.get(id)).toMatchObject({ shelf: 'site', owner: 'Ant-07', trust: 'unconfirmed' });

    expect((await call(ant, 'brain_search', { query: 'satoshi' })).text).toBe(`[fact] Brand font (${id})`);
    expect((await call(ant, 'brain_read', { query: 'satoshi' })).text).toContain(`(${id})`);
    const got = (await call(ant, 'brain_get', { id })).text;
    expect(got).toContain('[fact] Brand font');
    expect(got).toContain('trust unconfirmed');
    expect(got).toContain('owner Ant-07');
    expect(got).toContain('The site uses Satoshi for headings.');

    brain.write({ kind: 'decision', shelf: 'site', title: 'Use Tailwind 4', body: 'Only Tailwind 4.' }, user);
    expect((await call(ant, 'brain_boot_card')).text).toContain('Use Tailwind 4');
  });

  it('folds exact duplicates and reports it', async () => {
    const ant = await agent();
    const first = idIn((await call(ant, 'brain_write', { kind: 'update', title: 'Hero done', body: 'Built the hero.' })).text);
    expect((await call(ant, 'brain_write', { kind: 'update', title: 'Hero done', body: 'Built the hero.' })).text).toBe(
      `Already in the Brain as ${first} (exact duplicate; nothing new saved).`,
    );
  });

  it('update, history, link, links and archive', async () => {
    const ant = await agent();
    const a = idIn((await call(ant, 'brain_write', { kind: 'task', title: 'Hero', body: 'Build it.' })).text);
    const b = idIn((await call(ant, 'brain_write', { kind: 'task', title: 'Footer', body: 'Build it too.' })).text);
    expect((await call(ant, 'brain_update', { id: a, body: 'Build it with a video.' })).text).toBe(`Updated ${a} to version 2.`);
    expect((await call(ant, 'brain_history', { id: a })).text).toMatch(/^v1 create by Ant-07 .*\nv2 update by Ant-07 /);
    expect((await call(ant, 'brain_link', { from: a, to: b, rel: 'blocks' })).text).toBe(`Linked ${a} -blocks-> ${b}.`);
    expect((await call(ant, 'brain_links', { id: b })).text).toBe(`<-blocks- [task] Hero (${a})`);
    expect((await call(ant, 'brain_archive', { id: b })).text).toContain(`Archived ${b}`);
    expect((await call(ant, 'brain_search', { query: 'footer' })).text).toBe('No matches.');
  });
});

describe('Brain rules come back as clear tool errors', () => {
  it('trust: an agent cannot confirm', async () => {
    const r = await call(await agent(), 'brain_write', { kind: 'decision', title: 'Rebrand', body: 'Go purple.', trust: 'confirmed' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Brain error \(trust\): .*\nHint: Only the user can confirm/);
  });

  it('secret: refused, with the hint to use the vault', async () => {
    const r = await call(await agent(), 'brain_write', { kind: 'fact', title: 'AWS key', body: 'AKIAABCDEFGHIJKLMNOP' });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toMatch(/Brain error \(secret\)[\s\S]*vault/);
  });

  it('conflict: cannot edit what the user confirmed', async () => {
    const { id } = brain.write({ kind: 'decision', shelf: 'site', title: 'Keep the brand', body: 'No rebrand.' }, user);
    const r = await call(await agent(), 'brain_update', { id, body: 'Rebrand.' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Brain error \(conflict\)[\s\S]*new proposed decision/);
  });

  it('forbidden: agents cannot change the global shelf', async () => {
    const { id } = brain.write({ kind: 'update', shelf: 'global', title: 'Tone', body: 'Plain words.' }, user);
    const r = await call(await agent(), 'brain_archive', { id });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Brain error \(forbidden\)/);
  });

  it('not_found: other projects are invisible', async () => {
    const { id } = brain.write({ kind: 'fact', shelf: 'shop', title: 'Shop plan', body: 'May launch.' }, user);
    const ant = await agent();
    expect((await call(ant, 'brain_get', { id })).text).toMatch(/^No record .* that you can see/);
    const r = await call(ant, 'brain_history', { id });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Brain error \(not_found\)/);
  });
});

describe('shelf binding', () => {
  it('a shelf argument smuggled into an agent call is ignored; writes land on the token shelf', async () => {
    const ant = await agent({ shelf: 'site' });
    const r = await call(ant, 'brain_write', { kind: 'update', title: 'Note', body: 'A note.', shelf: 'shop' });
    expect(r.isError).toBe(false);
    expect(brain.get(idIn(r.text))?.shelf).toBe('site');
  });
});

describe('when the Brain is unreachable', () => {
  it('lists every tool and each explains the problem instead of hanging', async () => {
    const err = new BrainServiceError('unauthorized', 'INSECTOIDS_BRAIN_ENDPOINT and INSECTOIDS_BRAIN_TOKEN are not set.');
    const client = await mcpWith(unavailableAccess(err), { unavailableReason: err.message });
    expect(await toolNames(client)).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    expect(client.getInstructions()).toMatch(/unavailable/);
    const r = await call(client, 'brain_read', { query: 'anything' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Brain error \(unauthorized\)[\s\S]*Continue without the Brain/);
  });

  it('after the connection drops, the failed call reports it and the next call reconnects', async () => {
    const token = service.issueAgentToken({ agentId: 'Ant-07', shelf: 'site', write: true });
    const connectFresh = () => BrainClient.connect({ endpoint: service.endpoint, token });
    const first = await connectFresh();
    const access = clientAccess(first, async () => {
      const c = await connectFresh();
      cleanups.push(() => c.close());
      return c;
    });
    cleanups.push(() => access.close());
    const client = await mcpWith(access);
    first.close();
    const dropped = await call(client, 'brain_search', { query: 'x' });
    expect(dropped.isError).toBe(true);
    expect(dropped.text).toMatch(/^Brain error \(disconnected\)/);
    expect(await call(client, 'brain_search', { query: 'x' })).toEqual({ text: 'No matches.', isError: false });
  });
});

describe('B2: supersede, near-duplicates and history through MCP', () => {
  it('supersedes, says "already known" for near-duplicates, and marks history only on request', async () => {
    const client = await agent();
    const old = idIn((await call(client, 'brain_write', { kind: 'fact', title: 'Hosting', body: 'The site is on Netlify.' })).text);
    const next = await call(client, 'brain_write', { kind: 'fact', title: 'Hosting', body: 'The site moved to Vercel.', supersedes: old });
    expect(next.text).toMatch(/^Saved as /);
    const current = await call(client, 'brain_search', { query: 'hosting' });
    expect(current.text).not.toContain(old);
    const all = await call(client, 'brain_search', { query: 'hosting', includeHistory: true });
    expect(all.text).toContain(`(${old}) [SUPERSEDED]`);
    expect((await call(client, 'brain_get', { id: old })).text).toMatch(/SUPERSEDED by /);

    await call(client, 'brain_write', { kind: 'update', title: 'Checkout', body: 'The checkout page uses Stripe Elements for card entry.' });
    const dup = await call(client, 'brain_write', { kind: 'update', title: 'Checkout', body: 'the checkout page uses stripe elements, for card entry' });
    expect(dup.text).toMatch(/^Already known as "Checkout"/);
  });
});
