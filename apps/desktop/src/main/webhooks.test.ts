import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server, createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WEBHOOK_HOST,
  WEBHOOK_IPC,
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_MAX_CALLS_PER_MINUTE,
  WEBHOOK_MESSAGE_MAX_CHARS,
  WEBHOOK_SECRET_PREFIX,
  type WebhookCall,
  WebhookInfoSchema,
} from '@insectoids/shared';
import { AppSettingsStore } from './app-settings';
import { MSG, type WebhookCadence, WebhookSecrets, WebhookService, type WebhookVault, webhookMessage, webhookPort } from './webhooks';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
const { createWebhookHandlers } = await import('./webhook-ipc');

/** An in-memory Vault: refs look like the real ones; `available` can be switched off. */
function fakeVault(): WebhookVault & { entries: Map<string, { label: string; value: string }>; available: boolean } {
  let n = 0;
  const v = {
    entries: new Map<string, { label: string; value: string }>(),
    available: true,
    status: () => (v.available ? { available: true, message: 'ok' } : { available: false, message: 'No OS key store, so the Vault saves nothing.' }),
    add: (label: string, value: string) => {
      if (!v.available) throw new Error('No OS key store, so the Vault saves nothing.');
      const ref = `sec_${String(++n).padStart(8, '0')}`;
      v.entries.set(ref, { label, value });
      return ref;
    },
    reveal: (ref: string) => (v.available ? (v.entries.get(ref)?.value ?? null) : null),
    remove: (ref: string) => {
      if (!v.entries.delete(ref)) throw new Error('Unknown key.');
    },
  };
  return v;
}

interface Reply {
  status: number;
  body: { ok: boolean; message: string };
}

function post(port: number, path: string, body: string | Buffer, headers: Record<string, string> = {}, method = 'POST'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: WEBHOOK_HOST, port, path, method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Reply['body'] }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const sign = (body: string, secret: string): string => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

let dir: string;
let vault: ReturnType<typeof fakeVault>;
let settings: AppSettingsStore;
let secrets: WebhookSecrets;
let calls: WebhookCall[];
let hostUp: boolean;
let cadences: WebhookCadence[] | null;
let now: number;
let service: WebhookService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'insectoids-webhooks-'));
  vault = fakeVault();
  settings = new AppSettingsStore(dir);
  secrets = new WebhookSecrets({ vault, settings });
  calls = [];
  hostUp = true;
  cadences = [{ id: 'CAD-1', name: 'CI failed' }];
  now = 1_000_000;
  service = new WebhookService({
    secrets,
    settings,
    envPort: '0',
    now: () => now,
    webhookCadences: async () => cadences,
    call: async (c) => {
      calls.push(c);
      if (!hostUp) throw new Error('The Brain is not running.');
      return { status: c.kind === 'note' ? 200 : 202, ok: true, message: c.kind === 'note' ? 'Saved as a note.' : 'It waits in Approvals.' };
    },
  });
  await service.refreshNow();
});

afterEach(async () => {
  await service.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('webhook listener (Cadence 05-D4; Phase 3 A4)', () => {
  it('listens on 127.0.0.1 only, and only while the open project has a webhook cadence', async () => {
    expect(service.listening).toBe(true);
    expect(service.address?.address).toBe('127.0.0.1');
    expect(service.status).toBe(`Listening on this computer only (127.0.0.1:${service.port}).`);
    const port = service.port!;
    cadences = [];
    await service.refreshNow();
    expect(service.listening).toBe(false);
    await expect(post(port, '/hooks/CAD-1', '{}')).rejects.toThrow();
    // The hive can't say (Brain restarting): nothing changes.
    cadences = null;
    await service.refreshNow();
    expect(service.listening).toBe(false);
    cadences = [{ id: 'CAD-1', name: 'CI failed' }];
    await service.refreshNow();
    expect(service.listening).toBe(true);
  });

  it('says so in plain words when the port is taken', async () => {
    const other: Server = createServer();
    await new Promise<void>((r) => other.listen(0, WEBHOOK_HOST, () => r()));
    const taken = (other.address() as { port: number }).port;
    const s = new WebhookService({ secrets, settings, envPort: String(taken), webhookCadences: async () => cadences, call: async () => ({}) });
    await s.refreshNow();
    expect(s.listening).toBe(false);
    expect(s.status).toBe(`Port ${taken} is used by another app, so webhooks can't be called right now.`);
    await s.stop();
    await new Promise<void>((r) => other.close(() => r()));
  });

  it('accepts a call signed with either header, or carrying the secret as a bearer token', async () => {
    const secret = secrets.ensure('CAD-1', 'CI failed');
    const body = '{ "build": "failed",  "branch": "main" }';
    for (const header of ['X-Insectoids-Signature', 'X-Hub-Signature-256']) {
      const r = await post(service.port!, '/hooks/CAD-1', body, { [header]: sign(body, secret) });
      expect(r).toEqual({ status: 202, body: { ok: true, message: 'It waits in Approvals.' } });
    }
    const r = await post(service.port!, '/hooks/CAD-1', 'plain words', { Authorization: `Bearer ${secret}` });
    expect(r.status).toBe(202);
    expect(calls).toEqual([
      { cadenceId: 'CAD-1', kind: 'run', accepted: true, refusal: null, message: '{"build":"failed","branch":"main"}' },
      { cadenceId: 'CAD-1', kind: 'run', accepted: true, refusal: null, message: '{"build":"failed","branch":"main"}' },
      { cadenceId: 'CAD-1', kind: 'run', accepted: true, refusal: null, message: 'plain words' },
    ]);
    // No reply ever carries the secret.
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  it('sends /note calls as notes', async () => {
    const secret = secrets.ensure('CAD-1', 'CI failed');
    const r = await post(service.port!, '/hooks/CAD-1/note', 'Deploy finished', { Authorization: `Bearer ${secret}` });
    expect(r).toEqual({ status: 200, body: { ok: true, message: 'Saved as a note.' } });
    expect(calls[0]).toMatchObject({ kind: 'note', accepted: true, message: 'Deploy finished' });
  });

  it('refuses a wrong or missing secret with 401, and tells the hive so it is logged', async () => {
    const secret = secrets.ensure('CAD-1', 'CI failed');
    const body = '{"a":1}';
    const bad = await post(service.port!, '/hooks/CAD-1', body, { 'X-Insectoids-Signature': sign(body, `${secret}x`) });
    expect(bad).toEqual({ status: 401, body: { ok: false, message: MSG.badSecret } });
    expect((await post(service.port!, '/hooks/CAD-1', body, { 'X-Insectoids-Signature': 'sha256=short' })).status).toBe(401);
    expect((await post(service.port!, '/hooks/CAD-1', body, { Authorization: 'Bearer whsec_nope' })).status).toBe(401);
    const missing = await post(service.port!, '/hooks/CAD-1/note', body);
    expect(missing).toEqual({ status: 401, body: { ok: false, message: MSG.noSecret } });
    expect(calls).toHaveLength(4);
    expect(calls[0]).toEqual({ cadenceId: 'CAD-1', kind: 'run', accepted: false, refusal: MSG.badSecret, message: '' });
    expect(calls[3]).toEqual({ cadenceId: 'CAD-1', kind: 'note', accepted: false, refusal: MSG.noSecret, message: '' });
  });

  it('refuses when the secret is gone from the Vault (or the Vault is unavailable)', async () => {
    const secret = secrets.ensure('CAD-1', 'CI failed');
    vault.available = false;
    const r = await post(service.port!, '/hooks/CAD-1', '{}', { Authorization: `Bearer ${secret}` });
    expect(r).toEqual({ status: 401, body: { ok: false, message: MSG.secretMissing } });
    expect(calls[0]).toMatchObject({ accepted: false, refusal: MSG.secretMissing });
  });

  it('answers 404 for unknown webhooks and paths without asking the hive, and 405 for other methods', async () => {
    expect(await post(service.port!, '/hooks/CAD-9', '{}', { Authorization: 'Bearer x' })).toEqual({ status: 404, body: { ok: false, message: MSG.noSuchWebhook } });
    expect((await post(service.port!, '/hooks/CAD-1', '{}')).status).toBe(404); // no secret made yet
    expect((await post(service.port!, '/other', '{}')).status).toBe(404);
    expect((await post(service.port!, '/hooks/../x', '{}')).status).toBe(404);
    expect((await post(service.port!, '/hooks/CAD-1', '', {}, 'GET')).status).toBe(405);
    expect(calls).toEqual([]);
  });

  it('refuses bodies over 64 KB with 413', async () => {
    const secret = secrets.ensure('CAD-1', 'CI failed');
    const big = 'x'.repeat(WEBHOOK_MAX_BODY_BYTES + 1);
    const r = await post(service.port!, '/hooks/CAD-1', big, { Authorization: `Bearer ${secret}` });
    expect(r).toEqual({ status: 413, body: { ok: false, message: MSG.tooBig } });
    // Chunked (no Content-Length): reading stops once it passes the limit.
    const chunked = await post(service.port!, '/hooks/CAD-1', big, { Authorization: `Bearer ${secret}`, 'Transfer-Encoding': 'chunked' });
    expect(chunked.status).toBe(413);
    expect(calls.map((c) => c.accepted)).toEqual([false, false]);
  });

  it('refuses the 31st call in a minute with 429, and lets calls through again a minute later', async () => {
    const secret = secrets.ensure('CAD-1', 'CI failed');
    const auth = { Authorization: `Bearer ${secret}` };
    for (let i = 0; i < WEBHOOK_MAX_CALLS_PER_MINUTE; i++) expect((await post(service.port!, '/hooks/CAD-1/note', `n${i}`, auth)).status).toBe(200);
    const r = await post(service.port!, '/hooks/CAD-1/note', 'one more', auth);
    expect(r).toEqual({ status: 429, body: { ok: false, message: MSG.tooMany } });
    expect(calls.at(-1)).toMatchObject({ accepted: false, refusal: MSG.tooMany });
    now += 60_001;
    expect((await post(service.port!, '/hooks/CAD-1/note', 'later', auth)).status).toBe(200);
  });

  it("answers 503 when the hive isn't running", async () => {
    const secret = secrets.ensure('CAD-1', 'CI failed');
    hostUp = false;
    const r = await post(service.port!, '/hooks/CAD-1', '{}', { Authorization: `Bearer ${secret}` });
    expect(r).toEqual({ status: 503, body: { ok: false, message: MSG.hiveDown } });
  });
});

describe('webhook messages and port', () => {
  it('re-prints JSON compactly and cuts long bodies', () => {
    expect(webhookMessage(Buffer.from('{\n  "a": [1, 2]\n}'))).toBe('{"a":[1,2]}');
    expect(webhookMessage(Buffer.from('not { json'))).toBe('not { json');
    const cut = webhookMessage(Buffer.from('y'.repeat(WEBHOOK_MESSAGE_MAX_CHARS + 10)));
    expect(cut).toBe(`${'y'.repeat(WEBHOOK_MESSAGE_MAX_CHARS)} …(cut)`);
  });

  it('takes the port from the environment, then app.json, then the default', () => {
    expect(webhookPort('0', 5000)).toBe(0);
    expect(webhookPort(undefined, 5000)).toBe(5000);
    expect(webhookPort('nope', undefined)).toBe(47821);
  });
});

describe('webhook secrets in the Vault', () => {
  it('makes a secret once, keeps only its handle in app.json, rotates it and removes it', () => {
    const first = secrets.ensure('CAD-1', 'CI failed');
    expect(first).toMatch(new RegExp(`^${WEBHOOK_SECRET_PREFIX}[A-Za-z0-9_-]{43}$`));
    expect(secrets.ensure('CAD-1', 'CI failed')).toBe(first);
    const ref = settings.value.webhookSecrets?.['CAD-1'];
    expect(ref).toMatch(/^sec_/);
    expect(JSON.stringify(settings.value)).not.toContain(first);
    expect(vault.entries.get(ref!)?.label).toBe('Webhook secret · CI failed');

    const second = secrets.rotate('CAD-1', 'CI failed');
    expect(second).not.toBe(first);
    expect(vault.entries.has(ref!)).toBe(false);
    expect(secrets.reveal('CAD-1')).toBe(second);

    secrets.remove('CAD-1');
    expect(settings.value.webhookSecrets).toBeUndefined();
    expect(vault.entries.size).toBe(0);
    secrets.remove('CAD-1'); // nothing left: fine
  });

  it('makes a new one when its Vault entry was removed by hand, and fails closed without a Vault', () => {
    const first = secrets.ensure('CAD-1', 'CI failed');
    vault.entries.clear();
    const again = secrets.ensure('CAD-1', 'CI failed');
    expect(again).not.toBe(first);
    vault.available = false;
    expect(() => secrets.rotate('CAD-1', 'CI failed')).toThrow('No OS key store');
  });
});

describe('webhook IPC handlers', () => {
  const clipboard = { text: '', writeText(t: string) { this.text = t; } };
  const handlers = () =>
    createWebhookHandlers({ service, secrets, vault, webhookCadences: async () => cadences, clipboard });

  it('shows the URLs and status, never the secret', async () => {
    const info = WebhookInfoSchema.parse(await handlers()[WEBHOOK_IPC.info]('CAD-1'));
    expect(info).toMatchObject({
      cadenceId: 'CAD-1',
      runUrl: `http://127.0.0.1:${service.port}/hooks/CAD-1`,
      noteUrl: `http://127.0.0.1:${service.port}/hooks/CAD-1/note`,
      listening: true,
      hasSecret: false,
      secretHint: null,
      vaultAvailable: true,
    });
    await expect(handlers()[WEBHOOK_IPC.info]('CAD-9')).rejects.toThrow('No such webhook in this project.');
    await expect(handlers()[WEBHOOK_IPC.info]({ id: 'CAD-1' })).rejects.toThrow('No such webhook in this project.');
  });

  it('copies the secret to the clipboard in main, and a new one replaces it', async () => {
    const h = handlers();
    const copied = (await h[WEBHOOK_IPC.copySecret]('CAD-1')) as { ok: true; info: { hasSecret: boolean; secretHint: string } };
    expect(copied.ok).toBe(true);
    const secret = clipboard.text;
    expect(secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
    expect(JSON.stringify(copied)).not.toContain(secret);
    expect(copied.info).toMatchObject({ hasSecret: true, secretHint: `…${secret.slice(-4)}` });
    await h[WEBHOOK_IPC.copySecret]('CAD-1');
    expect(clipboard.text).toBe(secret);

    await h[WEBHOOK_IPC.newSecret]('CAD-1');
    expect(clipboard.text).not.toBe(secret);
    expect(secrets.reveal('CAD-1')).toBe(clipboard.text);
    expect(vault.entries.size).toBe(1);
  });

  it('refuses webhooks outside the open project, and says why without a Vault', async () => {
    expect(await handlers()[WEBHOOK_IPC.copySecret]('CAD-9')).toEqual({ ok: false, error: 'No such webhook in this project.' });
    vault.available = false;
    expect(await handlers()[WEBHOOK_IPC.newSecret]('CAD-1')).toEqual({ ok: false, error: 'No OS key store, so the Vault saves nothing.' });
  });
});
