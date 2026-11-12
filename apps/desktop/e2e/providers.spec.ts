import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * API providers (Phase 2 A4) through the real app: an Ollama-style provider on this computer, pointed at a
 * fake OpenAI-compatible server, is added, tested through the broker, and lists its models.
 * Local servers may use plain http on 127.0.0.1, so no test-only allowance is needed.
 */
let launched: LaunchedApp;
let fake: Server;
let fakeUrl = '';
const seenPaths: string[] = [];

test.beforeAll(async () => {
  fake = createServer((req, res) => {
    seenPaths.push(`${req.method} ${req.url}`);
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'llama3.2:3b' }, { id: 'qwen2.5-coder:7b' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', () => resolve()));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  launched = await launchApp();
});

test.afterAll(async () => {
  await launched?.close();
  await new Promise<void>((resolve) => fake.close(() => resolve()));
});

test('an Ollama-style provider on this computer: add, test through the broker, see its models', async () => {
  const { win } = launched;
  const saved = await win.evaluate(
    (baseUrl) =>
      (globalThis as unknown as AppWindow).insectoids.providers.save({
        id: 'ollama',
        label: 'Ollama',
        preset: 'ollama',
        baseUrl,
        secretRef: null,
        models: { strongest: 'qwen2.5-coder:7b', standard: 'llama3.2:3b', light: 'llama3.2:3b' },
        enabled: true,
      }),
    `${fakeUrl}/v1`,
  );
  expect(saved).toEqual({ ok: true });

  const tested = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.providers.test('ollama'));
  expect(tested).toMatchObject({ ok: true, status: 200, models: ['llama3.2:3b', 'qwen2.5-coder:7b'] });
  expect(seenPaths).toContain('GET /v1/models');

  const list = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.providers.list());
  expect(list).toEqual([
    expect.objectContaining({ id: 'ollama', status: 'ready', local: true, knownModels: ['llama3.2:3b', 'qwen2.5-coder:7b'] }),
  ]);
});

test('a remote provider must use https, and one that needs a key says so', async () => {
  const { win } = launched;
  const plain = await win.evaluate(() =>
    (globalThis as unknown as AppWindow).insectoids.providers.save({
      id: 'remote-http',
      label: 'Plain http',
      preset: 'custom',
      baseUrl: 'http://example.com/v1',
      secretRef: null,
      models: { strongest: 'a', standard: 'a', light: 'a' },
      enabled: true,
    }),
  );
  expect(plain).toMatchObject({ ok: false, error: expect.stringMatching(/https/) });

  const or = await win.evaluate(() =>
    (globalThis as unknown as AppWindow).insectoids.providers.save({
      id: 'openrouter',
      label: 'OpenRouter',
      preset: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      secretRef: null,
      models: { strongest: 'a', standard: 'a', light: 'a' },
      enabled: false,
    }),
  );
  expect(or).toEqual({ ok: true });
  const list = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.providers.list());
  expect(list.find((p) => p.id === 'openrouter')).toMatchObject({ status: 'needs-key', local: false });
  // Nothing went to openrouter.ai: saving and listing make no network calls.
  expect(await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.providers.remove('openrouter'))).toEqual({ ok: true });
});
