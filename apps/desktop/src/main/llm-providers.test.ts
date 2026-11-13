import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type IncomingHttpHeaders, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDERS_IPC, type Provider } from '@insectoids/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Broker } from './broker';
import { handleBrokerRequest } from './broker-requests';
import { ANTHROPIC_VERSION, LlmRoute, addUsage, streamRedactor, upstreamAuth } from './llm-route';
import { ProvidersStore, checkProviderBase } from './providers';
import { KNOWN_MODELS, createProvidersHandlers, modelIds } from './providers-handlers';
import { ServicesStore } from './services';
import { type SecretCrypto, Vault } from './vault';
import { createVaultHandlers } from './vault-handlers';

/** A planted fake provider key: it must never come back to the engine, a reply, a file or a log. */
const KEY = 'sk-or-FAKEtestKEY-0123456789abcdefXYZ';

const fakeCrypto: SecretCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64').split('').reverse().join('')}`),
  decryptString: (b) => Buffer.from(b.toString().slice(4).split('').reverse().join(''), 'base64').toString(),
};

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A fake OpenAI-compatible server. Its streaming chat echoes back the Authorization it received. */
let upstream: Server;
let upstreamUrl = '';
const seen: Seen[] = [];
let streamPlan: (res: ServerResponse, s: Seen) => void | Promise<void>;

const sse = (res: ServerResponse, obj: unknown): void => {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
};

function defaultStream(res: ServerResponse, s: Seen): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  sse(res, { model: 'llama3.2:3b', choices: [{ delta: { content: `you sent: ${s.headers['authorization'] ?? 'nothing'}` } }] });
  sse(res, { model: 'llama3.2:3b', choices: [{ delta: { content: ' done' } }], usage: { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } } });
  res.end('data: [DONE]\n\n');
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const s = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      seen.push(s);
      if (s.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        // "/empty/…" answers but lists nothing (C4: the known-models fallback).
        res.end(JSON.stringify({ data: s.url.includes('/empty/') ? [] : [{ id: 'llama3.2:3b' }, { id: 'qwen2.5-coder:7b' }] }));
        return;
      }
      if (s.url.endsWith('/chat/completions') && JSON.parse(body || '{}').stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: 'qwen2.5-coder:7b', choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 30, completion_tokens: 7 } }));
        return;
      }
      void streamPlan(res, s);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

let dir: string;
let vault: Vault;
let providers: ProvidersStore;
let llm: LlmRoute;
let broker: Broker;
let clock: number;
const logs: string[] = [];
let keyRef = '';

const provider = (o: Partial<Provider> = {}): Provider => ({
  id: 'keyed',
  label: 'Keyed (fake)',
  preset: 'custom',
  baseUrl: `${upstreamUrl}/v1`,
  secretRef: keyRef,
  models: { strongest: 'qwen2.5-coder:7b', standard: 'llama3.2:3b', light: 'llama3.2:3b' },
  enabled: true,
  ...o,
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'insectoids-llm-'));
  seen.length = 0;
  logs.length = 0;
  clock = 1_000_000;
  streamPlan = defaultStream;
  vault = new Vault({ dir, crypto: fakeCrypto });
  keyRef = vault.add('Fake provider key', KEY);
  providers = new ProvidersStore({ dir });
  providers.save(provider());
  providers.save(provider({ id: 'local', label: 'Ollama (fake)', preset: 'ollama', secretRef: null }));
  llm = new LlmRoute({ providers, reveal: (r) => vault.reveal(r), hasKey: (r) => vault.has(r), log: (l) => logs.push(l), now: () => clock, timeoutMs: 5_000 });
  broker = new Broker({ services: new ServicesStore({ dir }), reveal: (r) => vault.reveal(r), log: (l) => logs.push(l), llm });
  await broker.start();
});

afterEach(async () => {
  await broker.close();
  rmSync(dir, { recursive: true, force: true });
});

const chat = (baseUrl: string, pass: string, body: unknown = { model: 'llama3.2:3b', stream: true, messages: [{ role: 'user', content: 'hi' }] }, extra: Record<string, string> = {}) =>
  fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${pass}`, 'content-type': 'application/json', ...extra },
    body: JSON.stringify(body),
  });

describe('the broker LLM route: keys stay in main', () => {
  it('injects the key upstream, never returns it, and drops the caller\'s other headers', async () => {
    const { baseUrl, pass } = broker.issueLlm({ runId: 'r1', providerId: 'keyed' });
    expect(baseUrl).toBe(`${broker.url}/llm/keyed`);
    const res = await chat(baseUrl, pass, undefined, { cookie: 'session=1', 'x-api-key': 'nope', host: 'evil.example' });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(seen[0]!.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.headers['cookie']).toBeUndefined();
    expect(seen[0]!.headers['x-api-key']).toBeUndefined();
    // The fake echoed the Authorization it got: the engine sees it redacted, never the key or the pass.
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain(KEY);
    expect(seen[0]!.headers['authorization']).not.toContain(pass);
  });

  it('redacts a key split across stream chunks', async () => {
    streamPlan = async (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: {"choices":[{"delta":{"content":"leak ${KEY.slice(0, 11)}`);
      await new Promise((r) => setTimeout(r, 30));
      res.write(`${KEY.slice(11)} end"}}]}\n\n`);
      res.end('data: [DONE]\n\n');
    };
    const { baseUrl, pass } = broker.issueLlm({ runId: 'r1', providerId: 'keyed' });
    const text = await (await chat(baseUrl, pass)).text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(KEY.slice(0, 11));
    expect(text).toContain('leak [REDACTED] end');
  });

  it('streams through as it arrives (the first chunk comes before the provider finishes)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    streamPlan = async (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(res, { model: 'm', choices: [{ delta: { content: 'first chunk, long enough to pass the redaction hold-back window easily' } }] });
      await gate;
      res.end('data: [DONE]\n\n');
    };
    const { baseUrl, pass } = broker.issueLlm({ runId: 'r1', providerId: 'keyed' });
    const res = await chat(baseUrl, pass);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('first chunk');
    release();
    for (;;) if ((await reader.read()).done) break;
  });

  it('a local provider gets no Authorization at all', async () => {
    const { baseUrl, pass } = broker.issueLlm({ runId: 'r2', providerId: 'local' });
    await (await chat(baseUrl, pass)).text();
    expect(seen[0]!.headers['authorization']).toBeUndefined();
  });

  it('a pass is for one provider only; revoked and expired passes are refused', async () => {
    const a = broker.issueLlm({ runId: 'r1', providerId: 'keyed' });
    expect((await chat(`${broker.url}/llm/local`, a.pass)).status).toBe(403);
    expect((await chat(a.baseUrl, 'llm_madeup')).status).toBe(401);
    expect((await chat(a.baseUrl, '')).status).toBe(401);
    broker.revoke(a.pass);
    expect((await chat(a.baseUrl, a.pass)).status).toBe(401);
    const b = broker.issueLlm({ runId: 'r2', providerId: 'keyed' });
    clock += 3 * 60 * 60_000;
    expect((await chat(b.baseUrl, b.pass)).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('allows only the OpenAI paths, with no traversal or query', async () => {
    const { baseUrl, pass } = broker.issueLlm({ runId: 'r1', providerId: 'keyed' });
    const go = (path: string, method = 'POST') => fetch(`${broker.url}${path}`, { method, headers: { authorization: `Bearer ${pass}`, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : null });
    for (const bad of ['/llm/keyed/admin', '/llm/keyed/chat/completions/../../x', '/llm/keyed/%2e%2e/x', '/llm/keyed/chat/completions?x=1', '/llm/Keyed/models', '/llm/keyed']) {
      expect((await go(bad)).status, bad).toBeGreaterThanOrEqual(400);
    }
    expect((await go('/llm/keyed/models')).status).toBe(405); // /models is GET
    expect((await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${pass}` } })).status).toBe(200);
    expect(seen.map((s) => s.url)).toEqual(['/v1/models']);
  });

  it('records the model that answered and the tokens, from streams and plain JSON', async () => {
    const { baseUrl, pass } = broker.issueLlm({ runId: 'r1', providerId: 'local' });
    await (await chat(baseUrl, pass)).text();
    expect(broker.llmUsage(pass)).toEqual({ model: 'llama3.2:3b', input: 12, output: 5, cacheRead: 4, calls: 1 });
    await (await chat(baseUrl, pass, { model: 'asked-for', stream: false, messages: [] })).text();
    expect(broker.llmUsage(pass)).toEqual({ model: 'qwen2.5-coder:7b', input: 42, output: 12, cacheRead: 4, calls: 2 });
    broker.revoke(pass);
    // Still readable after the run ends (the hive reads it in its finally).
    expect(broker.llmUsage(pass).calls).toBe(2);
  });

  it('one call in flight per pass: a second call waits for the first', async () => {
    const order: string[] = [];
    let n = 0;
    streamPlan = async (res) => {
      const me = ++n;
      order.push(`start ${me}`);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      await new Promise((r) => setTimeout(r, 60));
      order.push(`end ${me}`);
      res.end('data: [DONE]\n\n');
    };
    const { baseUrl, pass } = broker.issueLlm({ runId: 'r1', providerId: 'local' });
    await Promise.all([chat(baseUrl, pass).then((r) => r.text()), chat(baseUrl, pass).then((r) => r.text())]);
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('a provider can\'t be used when it is off or its key is gone', () => {
    providers.setEnabled('keyed', false);
    expect(() => broker.issueLlm({ runId: 'r1', providerId: 'keyed' })).toThrow(/switched off/);
    expect(() => broker.issueLlm({ runId: 'r1', providerId: 'nope' })).toThrow(/No provider/);
  });
});

describe('the providers registry and its handlers', () => {
  it('https for remote providers; plain http only on this computer', () => {
    expect(checkProviderBase('https://openrouter.ai/api/v1')).toEqual({ ok: true, local: false });
    expect(checkProviderBase('http://127.0.0.1:11434/v1')).toEqual({ ok: true, local: true });
    expect(checkProviderBase('http://localhost:1234/v1')).toEqual({ ok: true, local: true });
    expect(checkProviderBase('http://example.com/v1').ok).toBe(false);
    expect(checkProviderBase('https://u:p@example.com/v1').ok).toBe(false);
    expect(() => providers.save(provider({ id: 'plain', baseUrl: 'http://example.com/v1' }))).toThrow(/https/);
  });

  it('test lists the models (stored as knownModels); status and FreeLLMAPI note', async () => {
    const h = createProvidersHandlers({ providers, vault, llm });
    const r = (await h[PROVIDERS_IPC.test]('local')) as { ok: boolean; models: string[] };
    expect(r).toMatchObject({ ok: true, models: ['llama3.2:3b', 'qwen2.5-coder:7b'] });
    const list = (await h[PROVIDERS_IPC.list](undefined)) as Array<{ id: string; status: string; local: boolean; knownModels: string[] }>;
    expect(list.find((p) => p.id === 'local')).toMatchObject({ status: 'ready', local: true, knownModels: ['llama3.2:3b', 'qwen2.5-coder:7b'] });
    providers.save(provider({ id: 'free', preset: 'freellmapi', secretRef: null }));
    const free = ((await h[PROVIDERS_IPC.list](undefined)) as Array<{ id: string; message: string }>).find((p) => p.id === 'free')!;
    expect(free.message).toMatch(/personal use/);
    providers.save(provider({ id: 'or', preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', secretRef: null }));
    expect(((await h[PROVIDERS_IPC.list](undefined)) as Array<{ id: string; status: string }>).find((p) => p.id === 'or')!.status).toBe('needs-key');
    expect(modelIds('[{"id":"a"},"b",{"name":"c"}]')).toEqual(['a', 'b', 'c']);
  });

  it('a provider in use by a run can\'t be switched off or removed', async () => {
    const h = createProvidersHandlers({ providers, vault, llm });
    const { pass } = broker.issueLlm({ runId: 'r1', providerId: 'local' });
    expect(await h[PROVIDERS_IPC.setEnabled]({ id: 'local', enabled: false })).toMatchObject({ ok: false, error: expect.stringMatching(/using this provider/) });
    expect(await h[PROVIDERS_IPC.remove]('local')).toMatchObject({ ok: false });
    broker.revoke(pass);
    expect(await h[PROVIDERS_IPC.setEnabled]({ id: 'local', enabled: false })).toEqual({ ok: true });
  });

  it('a Vault key used by an enabled provider can\'t be removed, and shows its user', async () => {
    const vh = createVaultHandlers({ vault, services: new ServicesStore({ dir }), broker, providers });
    expect(await vh['vault:remove'](keyRef)).toMatchObject({ ok: false, error: expect.stringMatching(/Keyed \(fake\)/) });
    const list = (await vh['vault:list'](undefined)) as Array<{ usedBy: string[] }>;
    expect(list[0]!.usedBy).toContain('keyed');
  });
});

describe('host requests and no leaks', () => {
  it('broker.issueLlm / llmUsage / revoke over the host channel', async () => {
    const issued = handleBrokerRequest(broker, 'broker.issueLlm' as never, { runId: 'run-1', providerId: 'local' }) as { baseUrl: string; pass: string };
    expect(issued.baseUrl).toMatch(/\/llm\/local$/);
    await (await chat(issued.baseUrl, issued.pass)).text();
    expect(handleBrokerRequest(broker, 'broker.llmUsage' as never, { pass: issued.pass })).toMatchObject({ model: 'llama3.2:3b', calls: 1 });
    handleBrokerRequest(broker, 'broker.revoke', { token: issued.pass });
    expect((await chat(issued.baseUrl, issued.pass)).status).toBe(401);
    expect(() => handleBrokerRequest(broker, 'broker.issueLlm' as never, { runId: 'x', providerId: 'BAD ID' })).toThrow();
  });

  it('a planted key never appears in any IPC reply, file, log or engine response', async () => {
    const h = createProvidersHandlers({ providers, vault, llm });
    const replies: unknown[] = [];
    // An engine call first (the handler loop below removes providers).
    const { baseUrl, pass } = broker.issueLlm({ runId: 'r1', providerId: 'keyed' });
    replies.push(await (await chat(baseUrl, pass)).text());
    replies.push(broker.llmUsage(pass));
    for (const [channel, fn] of Object.entries(h)) {
      for (const arg of [undefined, 'keyed', 'local', { id: 'keyed', enabled: true }, provider(), { junk: KEY }]) {
        try {
          replies.push(await fn(arg));
        } catch (err) {
          replies.push(String(err));
        }
      }
      expect(channel).toBeTruthy();
    }
    for (const r of replies) expect(JSON.stringify(r) ?? '').not.toContain(KEY);
    for (const l of logs) {
      expect(l).not.toContain(KEY);
      expect(l).not.toContain(pass);
    }
    expect(readFileSync(providers.file, 'utf8')).not.toContain(KEY);
  });

  it('helpers: usage from /responses shapes; the redactor holds back only a key\'s length', () => {
    const u = { model: null, input: 0, output: 0, cacheRead: 0, calls: 0 };
    addUsage(u, { type: 'response.completed', response: { model: 'gpt-x', usage: { input_tokens: 9, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } } } });
    expect(u).toEqual({ model: 'gpt-x', input: 9, output: 3, cacheRead: 2, calls: 0 });
    const r = streamRedactor('abcdef');
    expect(r.push('xx abc') + r.push('def yy') + r.end()).toBe('xx [REDACTED] yy');
    const none = streamRedactor(null);
    expect(none.push('as is')).toBe('as is');
  });
});

describe('direct API keys (C4): Anthropic and OpenAI presets', () => {
  it('Anthropic gets Bearer plus x-api-key and anthropic-version upstream; the engine never sees the key', async () => {
    providers.save(provider({ id: 'anthropic', label: 'Anthropic API', preset: 'anthropic' }));
    const { baseUrl, pass } = broker.issueLlm({ runId: 'r-a', providerId: 'anthropic' });
    const res = await chat(baseUrl, pass);
    const text = await res.text();
    expect(res.status).toBe(200);
    const s = seen.at(-1)!;
    expect(s.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(s.headers['x-api-key']).toBe(KEY);
    expect(s.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(text).not.toContain(KEY);
  });

  it('OpenAI gets only Bearer (no Anthropic headers)', async () => {
    providers.save(provider({ id: 'openai', label: 'OpenAI API', preset: 'openai' }));
    const { baseUrl, pass } = broker.issueLlm({ runId: 'r-o', providerId: 'openai' });
    expect((await chat(baseUrl, pass)).status).toBe(200);
    const s = seen.at(-1)!;
    expect(s.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(s.headers['x-api-key']).toBeUndefined();
    expect(s.headers['anthropic-version']).toBeUndefined();
  });

  it('both presets need a key; an Anthropic Test that lists nothing offers the known Claude models', async () => {
    providers.save(provider({ id: 'anthropic', label: 'Anthropic API', preset: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', secretRef: null }));
    providers.save(provider({ id: 'openai', label: 'OpenAI API', preset: 'openai', baseUrl: 'https://api.openai.com/v1', secretRef: null }));
    const h = createProvidersHandlers({ providers, vault, llm });
    const list = (await h[PROVIDERS_IPC.list](undefined)) as Array<{ id: string; status: string }>;
    expect(list.filter((p) => p.id === 'anthropic' || p.id === 'openai').map((p) => p.status)).toEqual(['needs-key', 'needs-key']);
    providers.save(provider({ id: 'anthropic', label: 'Anthropic API', preset: 'anthropic', baseUrl: `${upstreamUrl}/empty/v1` }));
    const r = (await h[PROVIDERS_IPC.test]('anthropic')) as { ok: boolean; models: string[] };
    expect(r.ok).toBe(true);
    expect(r.models).toEqual([...KNOWN_MODELS.anthropic!]);
    expect(seen.at(-1)!.headers['x-api-key']).toBe(KEY);
    expect(upstreamAuth({ preset: 'custom' }, null)).toEqual({});
  });
});
