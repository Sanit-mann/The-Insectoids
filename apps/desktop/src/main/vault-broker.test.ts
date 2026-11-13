import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VAULT_IPC } from '@insectoids/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Broker, MAX_BODY_BYTES, checkPath } from './broker';
import { handleBrokerRequest } from './broker-requests';
import { ServicesStore, testRequest } from './services';
import { type SecretCrypto, Vault } from './vault';
import { createVaultHandlers } from './vault-handlers';

/** A planted fake key: it must never show up in any reply, file, header back to the agent, audit or log. */
const KEY = 'ghp_FAKEtestKEY_0123456789abcdefXYZ';

/** Reversible stand-in for the OS (the real one is Electron safeStorage). */
const fakeCrypto = (available = true): SecretCrypto => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64').split('').reverse().join('')}`),
  decryptString: (b) => Buffer.from(b.toString().slice(4).split('').reverse().join(''), 'base64').toString(),
});

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let upstream: Server;
let upstreamUrl = '';
const seen: Seen[] = [];
let reply: (s: Seen) => { status: number; body: string; headers?: Record<string, string> } = () => ({ status: 200, body: '{"ok":true}' });

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const s = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      seen.push(s);
      const r = reply(s);
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
      res.end(r.body);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

let dir: string;
let vault: Vault;
let services: ServicesStore;
let broker: Broker;
const logs: string[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'insectoids-vault-'));
  seen.length = 0;
  logs.length = 0;
  reply = () => ({ status: 200, body: '{"ok":true}' });
  vault = new Vault({ dir, crypto: fakeCrypto() });
  services = new ServicesStore({ dir, rules: { allowLoopbackHttp: true, baseOverrides: { github: `${upstreamUrl}/gh` } } });
  broker = new Broker({ services, reveal: (r) => vault.reveal(r), log: (l) => logs.push(l), timeoutMs: 2_000 });
  await broker.start();
});

afterEach(async () => {
  await broker.close();
  rmSync(dir, { recursive: true, force: true });
});

/** GitHub (pointed at the fake upstream) with the planted key, switched on. */
function githubOn(): string {
  const ref = vault.add('GitHub token', KEY);
  const gh = services.get('github')!;
  services.save({ ...gh, secretRef: ref, enabled: true });
  return ref;
}

const call = async (token: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${broker.url}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

describe('the Vault (OS-encrypted, fail closed, handles only)', () => {
  it('stores ciphertext only, gives back a handle and a short hint, and decrypts for the broker', () => {
    const ref = vault.add('GitHub token', KEY);
    expect(ref).toMatch(/^sec_[a-z0-9]+$/);
    expect(vault.list()).toEqual([{ ref, label: 'GitHub token', hint: '…fXYZ', createdAt: expect.any(Number) }]);
    expect(readFileSync(vault.file, 'utf8')).not.toContain(KEY);
    expect(vault.reveal(ref)).toBe(KEY);
    expect(new Vault({ dir, crypto: fakeCrypto() }).reveal(ref)).toBe(KEY);
  });

  it('gives no hint for short keys', () => {
    vault.add('short', 'abcdefgh1');
    expect(vault.list()[0]!.hint).toBeNull();
  });

  it('fails closed without OS encryption: nothing saved, nothing revealed', () => {
    const off = new Vault({ dir, crypto: fakeCrypto(false) });
    expect(off.status().available).toBe(false);
    expect(() => off.add('x', KEY)).toThrow(/saves nothing|can't encrypt/i);
    const ref = vault.add('GitHub token', KEY);
    expect(off.reveal(ref)).toBeNull();
  });
});

describe('IPC replies never carry a key', () => {
  it('every handler, success and failure, is key-free; a key in use cannot be removed', async () => {
    const h = createVaultHandlers({ vault, services, broker });
    const replies: unknown[] = [];
    const add = (await h[VAULT_IPC.vaultAdd]({ label: 'GitHub token', value: KEY })) as { ok: boolean; ref: string };
    replies.push(add);
    expect(add.ok).toBe(true);
    const gh = services.get('github')!;
    replies.push(await h[VAULT_IPC.servicesSave]({ ...gh, secretRef: add.ref, enabled: true }));
    replies.push(await h[VAULT_IPC.vaultList](undefined));
    replies.push(await h[VAULT_IPC.vaultStatus](undefined));
    replies.push(await h[VAULT_IPC.servicesList](undefined));
    reply = (s) => ({ status: 200, body: JSON.stringify({ login: 'me', echo: s.headers['authorization'] }) });
    const test = (await h[VAULT_IPC.servicesTest]('github')) as { ok: boolean };
    replies.push(test);
    expect(test.ok).toBe(true);
    const refused = (await h[VAULT_IPC.vaultRemove](add.ref)) as { ok: boolean; error: string };
    replies.push(refused);
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/GitHub still uses this key/) });
    replies.push(await h[VAULT_IPC.vaultAdd]({ label: 'x', value: 'short' }));
    replies.push(await h[VAULT_IPC.servicesSave]({ ...gh, secretRef: 'sec_doesnotexist00', enabled: true }));
    replies.push(await h[VAULT_IPC.servicesSetEnabled]({ id: 'github', enabled: false }));
    replies.push(await h[VAULT_IPC.vaultRemove](add.ref));
    for (const r of replies) expect(JSON.stringify(r)).not.toContain(KEY);
    expect(JSON.stringify(replies)).not.toContain(KEY.slice(4, 20));
    expect(logs.join('\n')).not.toContain(KEY);
  });
});

describe('the secret broker', () => {
  it('injects the key, keeps only Accept/Content-Type from the caller, and never echoes the key back', async () => {
    githubOn();
    reply = (s) => ({ status: 200, body: JSON.stringify({ echo: s.headers['authorization'] }), headers: { 'x-echo': String(s.headers['authorization']) } });
    const t = broker.issue({ cardId: 'G.C-01', integrations: ['github'], approvedRules: [] });
    expect(t.granted).toEqual(['github']);
    const r = await call(t.token, { integration: 'github', method: 'GET', path: '/repos/a/b', query: { state: 'open' }, headers: { Accept: 'application/json', Cookie: 'c=1', Host: 'evil.com', 'X-Forwarded-For': '1.2.3.4' } });
    expect(r.status).toBe(200);
    const s = seen.at(-1)!;
    expect(s.url).toBe('/gh/repos/a/b?state=open');
    expect(s.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(s.headers['cookie']).toBeUndefined();
    expect(s.headers['x-forwarded-for']).toBeUndefined();
    expect(s.headers['host']).not.toBe('evil.com');
    expect(JSON.stringify(r.json)).not.toContain(KEY);
    expect(JSON.stringify(r.json)).toContain('[REDACTED]');
  });

  it('refuses missing, unknown, revoked and expired tokens', async () => {
    githubOn();
    const body = { integration: 'github', method: 'GET', path: '/user' };
    expect((await call('', body)).status).toBe(401);
    expect((await call('nope', body)).status).toBe(401);
    const t = broker.issue({ cardId: 'G.C-01', integrations: ['github'], approvedRules: [] });
    broker.revoke(t.token);
    expect((await call(t.token, body)).status).toBe(401);
    let now = 1_000;
    const short = new Broker({ services, reveal: (r) => vault.reveal(r), now: () => now, ttlMs: 50 });
    await short.start();
    const e = short.issue({ cardId: 'G.C-01', integrations: ['github'], approvedRules: [] });
    now += 100;
    expect((await short.call(e.token, body)).ok).toBe(false);
    await short.close();
  });

  it('a token only reaches the integrations its card was granted; switched-off or keyless ones are never granted', async () => {
    githubOn();
    const t = broker.issue({ cardId: 'G.C-01', integrations: ['github', 'brave-search', 'nope'], approvedRules: [] });
    expect(t.granted).toEqual(['github']);
    expect(t.denied.map((d) => d.id).sort()).toEqual(['brave-search', 'nope']);
    expect((await call(t.token, { integration: 'brave-search', method: 'GET', path: '/web/search' })).status).toBe(403);
    services.setEnabled('github', false);
    expect((await call(t.token, { integration: 'github', method: 'GET', path: '/user' })).status).toBe(403);
    expect(broker.issue({ cardId: 'G.C-02', integrations: ['github'], approvedRules: [] }).granted).toEqual([]);
  });

  it('keeps every call under the base URL: no traversal, no other host, no URL as path', async () => {
    githubOn();
    const t = broker.issue({ cardId: 'G.C-01', integrations: ['github'], approvedRules: [] });
    for (const path of ['/../admin', '/a/../../x', '//evil.com/x', 'https://evil.com/x', '/%2e%2e/x', '/a/%2E%2E/%2e%2e/x', '\\evil', '/x?y=1', 'relative']) {
      const r = await call(t.token, { integration: 'github', method: 'GET', path });
      expect(r.status, path).toBe(400);
    }
    expect(seen.length).toBe(0);
    expect(checkPath('/repos/a/b')).toBeNull();
  });

  it('write methods need the user\'s approval ("publish") for that card', async () => {
    githubOn();
    const t = broker.issue({ cardId: 'G.C-01', integrations: ['github'], approvedRules: [] });
    const r = await call(t.token, { integration: 'github', method: 'POST', path: '/repos/a/b/issues', body: '{"title":"x"}' });
    expect(r.status).toBe(403);
    expect(String(r.json['error'])).toMatch(/needs the user's approval.*STATUS: BLOCKED/);
    expect(seen.length).toBe(0);
    const ok = broker.issue({ cardId: 'G.C-01', integrations: ['github'], approvedRules: ['publish'] });
    expect((await call(ok.token, { integration: 'github', method: 'POST', path: '/repos/a/b/issues', body: '{"title":"x"}' })).status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ method: 'POST', body: '{"title":"x"}' });
  });

  it('caps big answers (marked truncated) without leaking a key split by the cap', async () => {
    githubOn();
    reply = () => ({ status: 200, body: `${'a'.repeat(MAX_BODY_BYTES - 10)}${KEY}${'b'.repeat(1000)}` });
    const t = broker.issue({ cardId: 'G.C-01', integrations: ['github'], approvedRules: [] });
    const r = await call(t.token, { integration: 'github', method: 'GET', path: '/big' });
    expect(r.json['truncated']).toBe(true);
    expect(String(r.json['body']).length).toBeLessThanOrEqual(MAX_BODY_BYTES + 20);
    expect(String(r.json['body'])).not.toContain(KEY.slice(0, 6));
  });

  it('audits calls without query values or keys, and never logs a key', async () => {
    githubOn();
    const t = broker.issue({ cardId: 'G.C-01', integrations: ['github'], approvedRules: [] });
    await call(t.token, { integration: 'github', method: 'GET', path: '/search/code', query: { q: 'secret-query' } });
    const audit = broker.audit();
    expect(audit.at(-1)).toMatchObject({ cardId: 'G.C-01', integration: 'github', method: 'GET', path: '/search/code', status: 200 });
    expect(JSON.stringify(audit)).not.toContain('secret-query');
    expect(JSON.stringify(audit) + logs.join('\n')).not.toContain(KEY);
  });

  it('only accepts JSON on POST /call (no CORS, no other routes)', async () => {
    githubOn();
    const t = broker.issue({ cardId: 'G.C-01', integrations: ['github'], approvedRules: [] });
    expect((await fetch(`${broker.url}/anything`)).status).toBe(404);
    const form = await fetch(`${broker.url}/call`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'text/plain' }, body: '{}' });
    expect(form.status).toBe(415);
    expect(form.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('host requests: checked input, tokens only for granted integrations', () => {
    githubOn();
    expect(() => handleBrokerRequest(broker, 'broker.issue', { cardId: 'c', agentId: 'a', integrations: ['../x'] })).toThrow();
    const r = handleBrokerRequest(broker, 'broker.issue', { cardId: 'G.C-01', agentId: 'Ant-01', integrations: ['github'], approvedRules: [] }) as { granted: string[]; token: string };
    expect(r.granted).toEqual(['github']);
    expect(handleBrokerRequest(broker, 'broker.available', undefined)).toEqual([{ id: 'github', description: expect.any(String) }]);
    expect(handleBrokerRequest(broker, 'broker.revoke', { token: r.token })).toEqual({ ok: true });
  });
});

describe('services registry', () => {
  it('built-ins start off; status follows key and switch; only https rest services can be added', () => {
    const views = services.views((r) => vault.has(r));
    expect(views.map((v) => [v.id, v.status, v.enabled])).toEqual([
      ['github', 'needs-key', false],
      ['brave-search', 'needs-key', false],
      ['notion', 'needs-key', false],
      ['linear', 'needs-key', false],
      ['slack', 'needs-key', false],
    ]);
    githubOn();
    expect(services.views((r) => vault.has(r))[0]!.status).toBe('ready');
    const strict = new ServicesStore({ dir });
    const rest = { id: 'notes', label: 'Notes', kind: 'rest' as const, baseUrl: 'http://example.com', authType: 'none' as const, authHeader: null, secretRef: null, enabled: false, readMethods: ['GET' as const], description: 'x' };
    expect(() => strict.save(rest)).toThrow(/https/);
    strict.save({ ...rest, baseUrl: 'https://example.com/api' });
    expect(strict.get('notes')?.baseUrl).toBe('https://example.com/api');
    expect(() => strict.remove('github')).toThrow(/switched off/);
  });
});

describe('Phase 2 services (C4): Notion, Linear, Slack, Jira', () => {
  let store: ServicesStore;
  let b: Broker;
  beforeEach(async () => {
    store = new ServicesStore({
      dir,
      rules: { allowLoopbackHttp: true, baseOverrides: { notion: `${upstreamUrl}/notion`, linear: `${upstreamUrl}/graphql`, slack: `${upstreamUrl}/slack` } },
    });
    b = new Broker({ services: store, reveal: (r) => vault.reveal(r), timeoutMs: 2_000 });
    await b.start();
  });
  afterEach(() => b.close());

  const on = (id: string, secret = KEY): void => {
    const ref = vault.add(`${id} key`, secret);
    store.save({ ...store.get(id)!, secretRef: ref, enabled: true });
  };
  const send = async (token: string, body: unknown) => {
    const res = await fetch(`${b.url}/call`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it('Notion: sends Notion-Version, reads with GET and the read-only POSTs, holds other POSTs for approval', async () => {
    on('notion');
    const t = b.issue({ cardId: 'G.C-01', integrations: ['notion'], approvedRules: [] });
    expect((await send(t.token, { integration: 'notion', method: 'GET', path: '/users/me' })).status).toBe(200);
    expect(seen.at(-1)!.headers['notion-version']).toBe('2022-06-28');
    expect(seen.at(-1)!.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect((await send(t.token, { integration: 'notion', method: 'POST', path: '/search', body: '{}' })).status).toBe(200);
    expect((await send(t.token, { integration: 'notion', method: 'POST', path: '/databases/abc123/query', body: '{}' })).status).toBe(200);
    const before = seen.length;
    // "*" is one segment only, and creating a page is a change.
    expect((await send(t.token, { integration: 'notion', method: 'POST', path: '/databases/a/b/query', body: '{}' })).status).toBe(403);
    expect((await send(t.token, { integration: 'notion', method: 'POST', path: '/pages', body: '{}' })).status).toBe(403);
    expect(seen.length).toBe(before);
  });

  it('Linear: a GraphQL query is a read, a mutation needs approval; the raw key goes in Authorization', async () => {
    on('linear');
    const t = b.issue({ cardId: 'G.C-01', integrations: ['linear'], approvedRules: [] });
    const q = await send(t.token, { integration: 'linear', method: 'POST', path: '/', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ viewer { id } }' }) });
    expect(q.status).toBe(200);
    expect(seen.at(-1)!.url).toBe('/graphql');
    expect(seen.at(-1)!.headers['authorization']).toBe(KEY);
    const before = seen.length;
    for (const query of ['mutation { issueCreate(input: {title: "x"}) { success } }', 'query A { viewer { id } } mutation B { x }', '  # just a comment\n subscription { x }']) {
      expect((await send(t.token, { integration: 'linear', method: 'POST', path: '/', body: JSON.stringify({ query }) })).status).toBe(403);
    }
    expect((await send(t.token, { integration: 'linear', method: 'POST', path: '/', body: 'not json' })).status).toBe(403);
    expect(seen.length).toBe(before);
    // The word inside a string is just text.
    const text = '{ issues(filter: {title: {contains: "mutation"}}) { nodes { id } } }';
    expect((await send(t.token, { integration: 'linear', method: 'POST', path: '/', body: JSON.stringify({ query: text }) })).status).toBe(200);
  });

  it('Slack: GET reads pass, posting a message needs approval', async () => {
    on('slack');
    const t = b.issue({ cardId: 'G.C-01', integrations: ['slack'], approvedRules: [] });
    expect((await send(t.token, { integration: 'slack', method: 'GET', path: '/auth.test' })).status).toBe(200);
    expect(seen.at(-1)!.url).toBe('/slack/auth.test');
    expect((await send(t.token, { integration: 'slack', method: 'POST', path: '/chat.postMessage', body: '{}' })).status).toBe(403);
  });

  it('Jira is added as a template with Basic auth; the broker encodes "email:token" and redacts both forms', async () => {
    const secret = 'me@example.com:FAKEjiraTOKEN0123456789';
    const ref = vault.add('Jira token', secret);
    store.save({ id: 'jira', label: 'Jira', kind: 'jira', baseUrl: `${upstreamUrl}/jira`, authType: 'basic', authHeader: null, secretRef: ref, enabled: true, readMethods: ['GET'], description: 'Jira' });
    const b64 = Buffer.from(secret).toString('base64');
    reply = (s) => ({ status: 200, body: JSON.stringify({ echoed: s.headers['authorization'], raw: secret }) });
    const t = b.issue({ cardId: 'G.C-01', integrations: ['jira'], approvedRules: [] });
    const r = await send(t.token, { integration: 'jira', method: 'GET', path: '/rest/api/3/myself' });
    expect(r.status).toBe(200);
    expect(seen.at(-1)!.headers['authorization']).toBe(`Basic ${b64}`);
    const text = JSON.stringify(r.json);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(b64);
    expect(text).toContain('[REDACTED]');
  });

  it('the Connections Jira template (GET+HEAD, search POSTs as reads) works through the broker', async () => {
    const ref = vault.add('Jira token', 'me@example.com:FAKEjiraTOKEN0123456789');
    store.save({
      id: 'jira', label: 'Jira', kind: 'jira', baseUrl: `${upstreamUrl}/jira`, authType: 'basic', authHeader: null, secretRef: ref, enabled: true,
      readMethods: ['GET', 'HEAD'], readPosts: ['/rest/api/3/search', '/rest/api/3/search/jql'], description: 'Jira',
    });
    const t = b.issue({ cardId: 'G.C-01', integrations: ['jira'], approvedRules: [] });
    expect((await send(t.token, { integration: 'jira', method: 'POST', path: '/rest/api/3/search/jql', body: '{"jql":"project = X"}' })).status).toBe(200);
    expect(seen.at(-1)!.headers['authorization']).toMatch(/^Basic /);
    expect((await send(t.token, { integration: 'jira', method: 'POST', path: '/rest/api/3/issue', body: '{}' })).status).toBe(403);
    expect(testRequest(store.get('jira')!)).toEqual({ method: 'GET', path: '/rest/api/3/myself' });
  });

  it('users can only add rest and jira; Jira needs Basic or Bearer; extra headers can never carry auth', () => {
    const base = { label: 'X', baseUrl: 'https://example.com/api', authHeader: null, secretRef: null, enabled: false, readMethods: ['GET' as const], description: 'x' };
    expect(() => store.save({ ...base, id: 'my-notion', kind: 'notion', authType: 'bearer' })).toThrow(/built in/);
    expect(() => store.save({ ...base, id: 'jira', kind: 'jira', authType: 'none' })).toThrow(/Basic|Bearer/);
    expect(() => store.save({ ...base, id: 'sneaky', kind: 'rest', authType: 'none', extraHeaders: { Authorization: 'Bearer x' } })).toThrow(/not allowed/);
    store.save({ ...base, id: 'jira', kind: 'jira', authType: 'basic', baseUrl: 'https://acme.atlassian.net' });
    expect(store.get('jira')).toMatchObject({ kind: 'jira', authType: 'basic', readPosts: [], extraHeaders: {} });
  });

  it('an extra header that slips in never overrides the key', async () => {
    const ref = vault.add('k', KEY);
    const raw = {
      id: 'odd', label: 'Odd', kind: 'rest' as const, baseUrl: `${upstreamUrl}/odd`, authType: 'bearer' as const, authHeader: null, secretRef: ref,
      enabled: true, readMethods: ['GET' as const], readPosts: [], extraHeaders: { Authorization: 'Bearer NOT-THE-KEY', 'X-Ok': 'yes' }, description: 'x',
    };
    const fake = { all: () => [raw], get: (id: string) => (id === 'odd' ? raw : undefined), rules: { allowLoopbackHttp: true } } as unknown as ServicesStore;
    const ob = new Broker({ services: fake, reveal: (r) => vault.reveal(r), timeoutMs: 2_000 });
    await ob.start();
    try {
      const r = await ob.callAsUser({ integration: 'odd', method: 'GET', path: '/x' });
      expect(r.ok).toBe(true);
      expect(seen.at(-1)!.headers['authorization']).toBe(`Bearer ${KEY}`);
      expect(seen.at(-1)!.headers['x-ok']).toBe('yes');
    } finally {
      await ob.close();
    }
  });

  it('testRequest makes a harmless read for every kind', () => {
    expect(testRequest(store.get('notion')!)).toEqual({ method: 'GET', path: '/users/me' });
    expect(testRequest(store.get('slack')!)).toEqual({ method: 'GET', path: '/auth.test' });
    const lin = testRequest(store.get('linear')!);
    expect(lin.method).toBe('POST');
    expect(JSON.parse(lin.body!)).toEqual({ query: '{ viewer { id } }' });
  });
});
