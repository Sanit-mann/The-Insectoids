import { connect } from 'node:net';
import { type Brain, openBrain } from '@insectoids/brain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BRAIN_ENV, BrainClient, BrainServiceError, type BrainService, startBrainService } from './index';

let brain: Brain;
let service: BrainService;
const clients: BrainClient[] = [];

const open = async (token: string): Promise<BrainClient> => {
  const c = await BrainClient.connect({ endpoint: service.endpoint, token });
  clients.push(c);
  return c;
};
const asAgent = (grant: { agentId?: string; shelf?: string; write?: boolean } = {}) =>
  open(service.issueAgentToken({ agentId: grant.agentId ?? 'Ant-07', shelf: grant.shelf ?? 'site', write: grant.write ?? true }));
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: unknown) => (e instanceof BrainServiceError ? e.code : `not a BrainServiceError: ${String(e)}`),
  );

beforeEach(async () => {
  brain = openBrain(':memory:');
  service = await startBrainService({ brain });
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await service.close();
  brain.close();
});

describe('connecting', () => {
  it('the master token is the user; an agent token is bound to its agent, shelf and access', async () => {
    const user = await open(service.masterToken);
    expect(user.identity).toEqual({ type: 'user' });
    const ant = await asAgent({ agentId: 'Ant-09', shelf: 'shop', write: false });
    expect(ant.identity).toEqual({ type: 'agent', id: 'Ant-09', shelf: 'shop', write: false });
    expect((await ant.ping()).v).toBe(1);
  });

  it('refuses unknown tokens', async () => {
    expect(await code(BrainClient.connect({ endpoint: service.endpoint, token: 'nope' }))).toBe('unauthorized');
  });

  it('reports a clear error when the service is not running', async () => {
    const endpoint = service.endpoint;
    await service.close();
    expect(await code(BrainClient.connect({ endpoint, token: 'x', timeoutMs: 2000 }))).toBe('disconnected');
    service = await startBrainService({ brain }); // for afterEach
  });

  it('connects from the INSECTOIDS_BRAIN_* environment', async () => {
    const env = { [BRAIN_ENV.endpoint]: service.endpoint, [BRAIN_ENV.token]: service.issueAgentToken({ agentId: 'A', shelf: 'site', write: false }) };
    const c = await BrainClient.fromEnv(env);
    clients.push(c);
    expect(c.identity).toMatchObject({ type: 'agent', id: 'A' });
    expect(await code(BrainClient.fromEnv({}))).toBe('unauthorized');
  });

  it('closes a connection that never says hello, and rejects junk frames', async () => {
    const reply = await new Promise<string>((resolve) => {
      const s = connect(service.endpoint);
      let got = '';
      s.setEncoding('utf8');
      s.on('data', (d: string) => (got += d));
      s.on('close', () => resolve(got));
      s.on('connect', () => s.write('not json\n'));
    });
    expect(JSON.parse(reply.trim())).toMatchObject({ type: 'error', error: { code: 'bad_request' } });
  });

  it('a revoked token stops working, also on open connections', async () => {
    const token = service.issueAgentToken({ agentId: 'A', shelf: 'site', write: true });
    const c = await open(token);
    service.revokeToken(token);
    expect(await code(c.ping())).toMatch(/unauthorized|disconnected/);
    expect(await code(BrainClient.connect({ endpoint: service.endpoint, token }))).toBe('unauthorized');
    expect(() => service.revokeToken(service.masterToken)).toThrow(/master/);
  });
});

describe('agents keep the Brain rules (01-D3, E6) through the service', () => {
  it('writes go to the agent shelf as the agent; facts start unconfirmed', async () => {
    const ant = await asAgent();
    const { id, created } = await ant.write({ kind: 'fact', title: 'Brand font', body: 'Satoshi' });
    expect(created).toBe(true);
    expect(brain.get(id)).toMatchObject({ shelf: 'site', owner: 'Ant-07', trust: 'unconfirmed' });
  });

  it('agents cannot confirm, leak secrets, or write to another shelf', async () => {
    const ant = await asAgent();
    expect(await code(ant.write({ kind: 'decision', title: 'X', body: 'Y', trust: 'confirmed' }))).toBe('trust');
    expect(await code(ant.write({ kind: 'fact', title: 'key', body: 'AKIAABCDEFGHIJKLMNOP' }))).toBe('secret');
    expect(await code(ant.write({ kind: 'fact', title: 'X', body: 'Y', shelf: 'shop' }))).toBe('forbidden');
  });

  it('agents cannot edit what the user confirmed', async () => {
    const { id } = brain.write({ kind: 'decision', shelf: 'site', title: 'Keep the brand', body: 'No rebrand.' }, { type: 'user' });
    const ant = await asAgent();
    expect(await code(ant.update({ id, body: 'Rebrand.' }))).toBe('conflict');
    expect(await code(ant.archive(id))).toBe('conflict');
  });

  it('a read-only token can read but not change anything', async () => {
    const { id } = brain.write({ kind: 'task', shelf: 'site', title: 'Hero', body: 'Build the hero.' }, { type: 'user' });
    const ant = await asAgent({ write: false });
    expect((await ant.get(id))?.title).toBe('Hero');
    for (const p of [ant.write({ kind: 'fact', title: 'a', body: 'b' }), ant.update({ id, body: 'x' }), ant.archive(id), ant.link({ from: id, to: id, rel: 'see' })]) {
      expect(await code(p)).toBe('forbidden');
    }
  });

  it('agents never see other projects; global is readable but not changeable', async () => {
    const user = { type: 'user' } as const;
    const shop = brain.write({ kind: 'fact', shelf: 'shop', title: 'Shop secret plan', body: 'Launch in May' }, user).id;
    const glob = brain.write({ kind: 'fact', shelf: 'global', title: 'Launch style', body: 'Plain words' }, user).id;
    const ant = await asAgent();

    expect(await ant.get(shop)).toBeNull();
    expect(await code(ant.history(shop))).toBe('not_found');
    expect((await ant.search({ query: 'launch' })).map((h) => h.id)).toEqual([glob]);
    expect(await code(ant.search({ query: 'launch', shelf: 'shop' }))).toBe('forbidden');
    expect((await ant.get(glob))?.title).toBe('Launch style');
    expect(await code(ant.update({ id: glob, body: 'x' }))).toBe('forbidden');
  });

  it('links only between visible records, and hidden links are filtered out', async () => {
    const user = { type: 'user' } as const;
    const a = brain.write({ kind: 'task', shelf: 'site', title: 'A', body: 'a' }, user).id;
    const b = brain.write({ kind: 'task', shelf: 'site', title: 'B', body: 'b' }, user).id;
    const hidden = brain.write({ kind: 'task', shelf: 'shop', title: 'H', body: 'h' }, user).id;
    brain.link(a, hidden, 'see');
    const ant = await asAgent();
    await ant.link({ from: a, to: b, rel: 'blocks' });
    expect(await ant.links(a)).toEqual([{ id: b, rel: 'blocks', direction: 'out' }]);
    expect(await code(ant.link({ from: a, to: hidden, rel: 'see' }))).toBe('not_found');
  });

  it('boot card and token-budgeted read use the agent shelf', async () => {
    brain.write({ kind: 'decision', shelf: 'site', title: 'Use Tailwind', body: 'Tailwind 4 only.' }, { type: 'user' });
    const ant = await asAgent();
    expect((await ant.bootCard()).text).toContain('Use Tailwind');
    const r = await ant.read({ query: 'tailwind', tokenBudget: 100 });
    expect(r.ids).toHaveLength(1);
  });
});

describe('the user (app) side', () => {
  it('user writes are confirmed and need an explicit shelf', async () => {
    const app = await open(service.masterToken);
    expect(await code(app.write({ kind: 'fact', title: 'a', body: 'b' }))).toBe('bad_request');
    const { id } = await app.write({ kind: 'fact', title: 'Hosting', body: 'Vercel', shelf: 'site' });
    expect(brain.get(id)?.trust).toBe('confirmed');
  });

  it('only the app may mint and revoke tokens', async () => {
    const app = await open(service.masterToken);
    const { token } = await app.call('admin.issueToken', { agentId: 'Ant-1', shelf: 'site', write: false });
    const ant = await open(token);
    expect(ant.identity).toMatchObject({ id: 'Ant-1', write: false });
    expect(await code(ant.call('admin.issueToken', { agentId: 'me', shelf: 'site', write: true }))).toBe('forbidden');
    await app.call('admin.revokeToken', { token });
    expect(await code(BrainClient.connect({ endpoint: service.endpoint, token }))).toBe('unauthorized');
  });

  it('validates params and unknown methods', async () => {
    const app = await open(service.masterToken);
    expect(await code(app.write({ kind: 'nope' as 'fact', title: 'a', body: 'b', shelf: 'site' }))).toBe('bad_request');
    expect(await code(app.write({ kind: 'fact', title: 'a', body: 'b', shelf: 'Bad Shelf!' }))).toBe('bad_request');
    expect(await code(app.call('drop' as 'ping', {}))).toBe('bad_request');
    expect(await code(app.get('missing'))).toBe('resolved');
  });
});

describe('single writer under load', () => {
  it('many clients writing at once all land, each exactly once', async () => {
    const ants = await Promise.all(Array.from({ length: 8 }, (_, i) => asAgent({ agentId: `Ant-${i}` })));
    const results = await Promise.all(
      ants.flatMap((ant, i) => Array.from({ length: 25 }, (_, j) => ant.write({ kind: 'update', title: `u${i}-${j}`, body: `note ${i} ${j}` }))),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(200);
    // Duplicate guard still holds across connections.
    const again = await ants[3]!.write({ kind: 'update', title: 'u0-0', body: 'note 0 0' });
    expect(again.created).toBe(false);
  });
});

describe('meaning search through the service (Phase 2 B1)', () => {
  it('embeds the query in-process: agents get meaning hits without ever sending a vector', async () => {
    await service.close();
    const axis = (i: number) => {
      const v = new Float32Array(4);
      v[i] = 1;
      return v;
    };
    const calls: string[] = [];
    service = await startBrainService({
      brain,
      embedQuery: async (text) => {
        calls.push(text);
        return { vector: axis(0), model: 'm' };
      },
    });
    const id = brain.write({ kind: 'fact', shelf: 'site', title: 'Vault', body: 'API keys are encrypted.' }, { type: 'user' }).id;
    const p = brain.pendingVectors('m')[0]!;
    brain.setVector(id, 'm', axis(0), p.contentHash);
    const ant = await asAgent();
    const hits = await ant.search({ query: 'how are passwords protected' });
    expect(hits.map((h) => [h.id, h.match])).toEqual([[id, 'meaning']]);
    expect((await ant.read({ query: 'how are passwords protected' })).ids).toEqual([id]);
    expect(calls).toEqual(['how are passwords protected', 'how are passwords protected']);
  });

  it('a failing embedder only costs the meaning part: word search still answers', async () => {
    await service.close();
    service = await startBrainService({ brain, embedQuery: async () => Promise.reject(new Error('wasm failed')) });
    const id = brain.write({ kind: 'fact', shelf: 'site', title: 'Vault', body: 'keys' }, { type: 'user' }).id;
    const ant = await asAgent();
    expect((await ant.search({ query: 'keys' })).map((h) => [h.id, h.match])).toEqual([[id, 'words']]);
  });
});

describe('the code map (B4)', () => {
  const file = (path: string, name: string) => ({
    path,
    language: 'typescript',
    contentHash: 'h',
    size: 10,
    imports: [],
    symbols: [{ name, qualified: name, kind: 'function' as const, line: 1, endLine: 3, signature: `function ${name}()`, doc: null, parent: null }],
    edges: [],
  });

  it('agents look up only their project map, read-only tokens included; the user names a shelf', async () => {
    brain.code.putFile('site', file('src/a.ts', 'slugify'));
    brain.code.putFile('shop', file('src/b.ts', 'secretShopFn'));
    const ant = await asAgent({ write: false });
    expect((await ant.code({ query: 'slug' })).hits.map((h) => h.name)).toEqual(['slugify']);
    expect((await ant.code({ query: 'secretShopFn' })).hits).toEqual([]);
    expect(await code(ant.code({ query: 'x', shelf: 'shop' }))).toBe('forbidden');
    expect((await ant.code({ query: 'a.ts', mode: 'file' })).message).toMatch(/src\/a\.ts: 1 symbol/);
    const user = await open(service.masterToken);
    expect(await code(user.code({ query: 'x' }))).toBe('bad_request');
    expect((await user.code({ query: 'secret', shelf: 'shop' })).hits.map((h) => h.path)).toEqual(['src/b.ts']);
  });
});
