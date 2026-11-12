import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VAULT_IPC } from '@insectoids/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Broker, MAX_BODY_BYTES, checkPath } from './broker';
import { handleBrokerRequest } from './broker-requests';
import { ServicesStore } from './services';
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
