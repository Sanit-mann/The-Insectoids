import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { type AppWindow, type LaunchedApp, NO_KEY_STORE, launchApp, noKeyStoreOnLinux } from './support/launch';

/**
 * The Vault and the secret broker through the real app (Phase 2 A3), with a fake GitHub on 127.0.0.1
 * (an e2e-only switch lets a loopback upstream stand in; a normal run allows https only).
 * The key is a fake value: it must reach the upstream as the auth header and never come back to the UI.
 */
const KEY = 'ghp_E2EfakeKEY_abcdefghijklmnop1234';

let upstream: Server;
let base = '';
const seen: IncomingHttpHeaders[] = [];
let launched: LaunchedApp;

test.beforeAll(async () => {
  upstream = createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(req.headers['authorization'] === `Bearer ${KEY}` ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ login: 'e2e', echoed: req.headers['authorization'] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/api`;
  launched = await launchApp({ env: { INSECTOIDS_E2E_LOOPBACK_SERVICES: '1', INSECTOIDS_E2E_GITHUB_BASE: base } });
});

test.afterAll(async () => {
  await launched?.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

test('a key goes into the Vault once, is used by the broker, and never comes back', async () => {
  const { win } = launched;
  test.skip(await noKeyStoreOnLinux(win), NO_KEY_STORE);
  expect(await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.vault.status())).toMatchObject({ available: true });

  const added = await win.evaluate((value) => (globalThis as unknown as AppWindow).insectoids.vault.add({ label: 'GitHub token', value }), KEY);
  expect(added).toMatchObject({ ok: true, ref: expect.stringMatching(/^sec_/) });
  const listed = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.vault.list());
  expect(listed).toEqual([{ ref: added.ref, label: 'GitHub token', hint: '…1234', createdAt: expect.any(Number), usedBy: [] }]);

  // Built-ins start off and need a key.
  const before = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.vault.services());
  expect(before.map((s) => [s.id, s.status])).toEqual([
    ['github', 'needs-key'],
    ['brave-search', 'needs-key'],
    ['notion', 'needs-key'],
    ['linear', 'needs-key'],
    ['slack', 'needs-key'],
  ]);

  const github = before.find((s) => s.id === 'github')!;
  const integration = {
    id: github.id, label: github.label, kind: github.kind, baseUrl: github.baseUrl, authType: github.authType,
    authHeader: github.authHeader, secretRef: github.secretRef, enabled: github.enabled, readMethods: github.readMethods, description: github.description,
  };
  expect(await win.evaluate((i) => (globalThis as unknown as AppWindow).insectoids.vault.saveService(i), { ...integration, secretRef: added.ref!, enabled: true })).toEqual({ ok: true });

  // The test call goes through the broker: the fake GitHub sees the key as the auth header.
  const tested = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.vault.testService('github'));
  expect(tested).toMatchObject({ ok: true, status: 200 });
  expect(seen.at(-1)?.['authorization']).toBe(`Bearer ${KEY}`);
  expect(seen.at(-1)?.['cookie']).toBeUndefined();

  const after = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.vault.services());
  expect(after.find((s) => s.id === 'github')).toMatchObject({ status: 'ready', enabled: true, lastTestedAt: expect.any(Number) });
  expect((await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.vault.list()))[0]!.usedBy).toEqual(['github']);

  // A key still in use can't be removed; switched off, it can.
  expect(await win.evaluate((ref) => (globalThis as unknown as AppWindow).insectoids.vault.remove(ref), added.ref!)).toMatchObject({ ok: false, error: expect.stringMatching(/GitHub still uses this key/) });
  expect(await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.vault.setServiceEnabled('github', false))).toEqual({ ok: true });
  expect(await win.evaluate((ref) => (globalThis as unknown as AppWindow).insectoids.vault.remove(ref), added.ref!)).toEqual({ ok: true });

  // Nothing the UI received ever held the key.
  const everything = JSON.stringify([added, listed, before, tested, after, await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.vault.services())]);
  expect(everything).not.toContain(KEY);
});

test('the Vault refuses junk and only https services can be added', async () => {
  const { win } = launched;
  expect(await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.vault.add({ label: 'x', value: 'short' }))).toMatchObject({ ok: false });
  const http = { id: 'notes', label: 'Notes', kind: 'rest' as const, baseUrl: 'http://example.com', authType: 'none' as const, authHeader: null, secretRef: null, enabled: false, readMethods: ['GET' as const], description: 'x' };
  expect(await win.evaluate((i) => (globalThis as unknown as AppWindow).insectoids.vault.saveService(i), http)).toMatchObject({ ok: false, error: expect.stringMatching(/https/) });
  expect(await win.evaluate((i) => (globalThis as unknown as AppWindow).insectoids.vault.saveService(i), { ...http, baseUrl: 'https://example.com/api' })).toEqual({ ok: true });
  expect(await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.vault.removeService('github'))).toMatchObject({ ok: false, error: expect.stringMatching(/switched off/) });
  expect(await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.vault.removeService('notes'))).toEqual({ ok: true });
});
