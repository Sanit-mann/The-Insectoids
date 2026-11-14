import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import {
  DEFAULT_WEBHOOK_PORT,
  WEBHOOK_GITHUB_SIGNATURE_HEADER,
  WEBHOOK_HOST,
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_MAX_CALLS_PER_MINUTE,
  WEBHOOK_MESSAGE_MAX_CHARS,
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookCall,
  type WebhookCallKind,
  WebhookCallSchema,
  WebhookReplySchema,
} from '@insectoids/shared';
import type { AppSettings } from './app-settings';

/**
 * Webhooks in main (Cadence 05-D2, D4; Phase 3 A4): the local listener and each webhook's secret.
 *
 * - The listener is node:http on 127.0.0.1 only, and only while the open project has a webhook cadence.
 * - It checks the secret, size and rate itself, then hands a `WebhookCall` to the Brain host, which applies the
 *   cadence's trust mode and says what to answer.
 * - Each secret lives in the Vault (04-D4); app.json keeps only its handle. Fail closed: without the OS key store
 *   no secret exists, so every call is refused.
 * - Nothing here logs a body or a secret, and no reply carries one.
 */

/** The parts of the Vault webhooks use (injectable for tests). */
export interface WebhookVault {
  status(): { available: boolean; message: string };
  add(label: string, value: string): string;
  reveal(ref: string): string | null;
  remove(ref: string): void;
}

/** The parts of app.json webhooks use. */
export interface WebhookSettings {
  readonly value: Pick<AppSettings, 'webhookSecrets' | 'webhookPort'>;
  update(change: (s: AppSettings) => AppSettings): unknown;
}

/** A webhook cadence of the open project, as far as main needs it. */
export interface WebhookCadence {
  id: string;
  name: string;
}

const PATH = /^\/hooks\/([A-Za-z0-9_-]{1,200})(\/note)?$/;
/** Same rule as the URL path, for ids that come over IPC. */
export const WEBHOOK_ID = /^[A-Za-z0-9_-]{1,200}$/;
const MINUTE = 60_000;
const REFRESH_DEBOUNCE_MS = 300;
/** Short limits, so a slow or stuck sender can't hold a connection open. */
const REQUEST_TIMEOUT_MS = 10_000;

export const MSG = {
  noSuchWebhook: 'No such webhook.',
  usePost: 'Use POST.',
  tooBig: `The call is too big (over ${WEBHOOK_MAX_BODY_BYTES / 1024} KB).`,
  tooMany: `Too many calls to this webhook (over ${WEBHOOK_MAX_CALLS_PER_MINUTE} a minute). Try again in a minute.`,
  noSecret: 'The call carried no secret.',
  badSecret: "The signature doesn't match this webhook's secret.",
  secretMissing: "This webhook's secret is missing from the Vault. Make a new one on the Cadence screen.",
  hiveDown: "The hive isn't running right now. Try again in a minute.",
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Secrets

/** Each webhook's secret: made here, kept in the Vault, mapped by cadence id in app.json. */
export class WebhookSecrets {
  constructor(private readonly o: { vault: WebhookVault; settings: WebhookSettings }) {}

  /** The Vault handle for this webhook, or null. */
  refOf(cadenceId: string): string | null {
    return Object.hasOwn(this.o.settings.value.webhookSecrets ?? {}, cadenceId) ? this.o.settings.value.webhookSecrets![cadenceId]! : null;
  }

  /** The secret itself (listener and clipboard only), or null when there is none or it can't be read. */
  reveal(cadenceId: string): string | null {
    const ref = this.refOf(cadenceId);
    return ref ? this.o.vault.reveal(ref) : null;
  }

  /** "…a1b2" for the Cadence screen, or null. */
  hint(cadenceId: string): string | null {
    const s = this.reveal(cadenceId);
    return s && s.length >= 12 ? `…${s.slice(-4)}` : null;
  }

  /** The secret, made first when there is none (or its Vault entry is gone). Throws in plain words without a Vault. */
  ensure(cadenceId: string, name: string): string {
    return this.reveal(cadenceId) ?? this.rotate(cadenceId, name);
  }

  /** A new secret; the old one stops working at once. Throws in plain words without a Vault. */
  rotate(cadenceId: string, name: string): string {
    const vault = this.o.vault.status();
    if (!vault.available) throw new Error(vault.message);
    const secret = `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
    const ref = this.o.vault.add(`Webhook secret · ${name}`, secret);
    const old = this.refOf(cadenceId);
    this.#setRef(cadenceId, ref);
    if (old) this.#forget(old);
    return secret;
  }

  /** Removes the secret (Vault entry and mapping), e.g. when the cadence is deleted. */
  remove(cadenceId: string): void {
    const ref = this.refOf(cadenceId);
    if (!ref) return;
    this.#setRef(cadenceId, null);
    this.#forget(ref);
  }

  #setRef(cadenceId: string, ref: string | null): void {
    this.o.settings.update((s) => {
      const map = { ...(s.webhookSecrets ?? {}) };
      if (ref) map[cadenceId] = ref;
      else delete map[cadenceId];
      const next: AppSettings = { ...s, webhookSecrets: map };
      if (!Object.keys(map).length) delete next.webhookSecrets;
      return next;
    });
  }

  /** An unknown Vault entry (already removed by hand) is fine. */
  #forget(ref: string): void {
    try {
      this.o.vault.remove(ref);
    } catch {
      // Already gone.
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Checks (pure)

/** Equal-length, constant-time comparison; a different length is simply no match. */
function same(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Does the call carry this webhook's secret (a signature over the raw body, or the secret as a bearer token)? */
export function checkSecret(headers: IncomingHttpHeaders, body: Buffer, secret: string): 'ok' | 'missing' | 'bad' {
  const signatures = [one(headers[WEBHOOK_SIGNATURE_HEADER]), one(headers[WEBHOOK_GITHUB_SIGNATURE_HEADER])].filter((s): s is string => !!s);
  const auth = one(headers.authorization);
  const bearer = auth ? /^Bearer\s+(\S+)\s*$/i.exec(auth)?.[1] : undefined;
  if (!signatures.length && !bearer) return 'missing';
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  if (signatures.some((s) => same(s.trim().toLowerCase(), expected))) return 'ok';
  if (bearer && same(bearer, secret)) return 'ok';
  return 'bad';
}

/** The body as text for the hive: JSON re-printed compactly, cut to WEBHOOK_MESSAGE_MAX_CHARS. */
export function webhookMessage(body: Buffer): string {
  let text = body.toString('utf8');
  try {
    text = JSON.stringify(JSON.parse(text));
  } catch {
    // Not JSON: kept as text.
  }
  if (text.length <= WEBHOOK_MESSAGE_MAX_CHARS) return text;
  let end = WEBHOOK_MESSAGE_MAX_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--; // never split a surrogate pair
  return `${text.slice(0, end)} …(cut)`;
}

/** The port: INSECTOIDS_WEBHOOK_PORT (e2e: 0 = a free one), else app.json, else the default. */
export function webhookPort(env: string | undefined, configured: number | undefined): number {
  if (env !== undefined && /^\d{1,5}$/.test(env.trim()) && Number(env) <= 65_535) return Number(env);
  return configured ?? DEFAULT_WEBHOOK_PORT;
}

// ---------------------------------------------------------------------------------------------------------------
// The listener

export interface WebhookServiceOptions {
  secrets: WebhookSecrets;
  settings: WebhookSettings;
  /** Hands a call to the Brain host (`webhookCall`); throws when the host isn't ready. */
  call: (call: WebhookCall) => Promise<unknown>;
  /** The open project's webhook cadences, or null when the hive can't say (Brain not ready). */
  webhookCadences: () => Promise<WebhookCadence[] | null>;
  /** INSECTOIDS_WEBHOOK_PORT. */
  envPort?: string | undefined;
  now?: () => number;
  log?: (line: string) => void;
}

export class WebhookService {
  readonly #o: WebhookServiceOptions;
  readonly #now: () => number;
  #server: Server | null = null;
  #port: number | null = null;
  /** Why it isn't listening although it should, in words. */
  #problem: string | null = null;
  #stopped = false;
  #timer: NodeJS.Timeout | null = null;
  /** Serializes start/stop so overlapping refreshes never race. */
  #queue: Promise<void> = Promise.resolve();
  /** Recent accepted-for-checking call times per webhook (rate limit). */
  readonly #calls = new Map<string, number[]>();

  constructor(o: WebhookServiceOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
  }

  /** The port it answers on right now, or null. */
  get port(): number | null {
    return this.#port;
  }

  get listening(): boolean {
    return this.#port !== null;
  }

  /** The port from the environment or app.json (what the URL shows while not listening). */
  get configuredPort(): number {
    return webhookPort(this.#o.envPort, this.#o.settings.value.webhookPort);
  }

  /** In words, for the Cadence screen. */
  get status(): string {
    if (this.#port !== null) return `Listening on this computer only (${WEBHOOK_HOST}:${this.#port}).`;
    if (this.#problem) return this.#problem;
    return "Not listening: this project has no webhooks yet.";
  }

  /** On every hive change and Brain (re)start: re-checks whether to listen, debounced. */
  refresh(): void {
    if (this.#stopped || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.refreshNow();
    }, REFRESH_DEBOUNCE_MS);
  }

  /** Re-checks now; resolves once the listener follows the open project. */
  async refreshNow(): Promise<void> {
    const list = await this.#o.webhookCadences().catch(() => null);
    // The hive can't say right now (Brain starting or down): keep things as they are until it can.
    if (list === null) return this.#queue;
    return this.#apply(list.length > 0);
  }

  /** Closes the listener for good (app quit). */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    return this.#apply(false);
  }

  #apply(want: boolean): Promise<void> {
    this.#queue = this.#queue.then(async () => {
      const should = want && !this.#stopped;
      if (should && !this.#server) await this.#listen();
      else if (!should && this.#server) await this.#close();
      if (!should) this.#problem = null;
    });
    return this.#queue;
  }

  async #listen(): Promise<void> {
    const port = this.configuredPort;
    const server = createServer({ requestTimeout: REQUEST_TIMEOUT_MS, headersTimeout: REQUEST_TIMEOUT_MS }, (req, res) => {
      void this.#handle(req, res);
    });
    server.keepAliveTimeout = 2_000;
    server.maxHeadersCount = 50;
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      server.once('error', resolve);
      server.listen(port, WEBHOOK_HOST, () => {
        server.off('error', resolve);
        resolve(null);
      });
    });
    if (err) {
      this.#problem =
        err.code === 'EADDRINUSE'
          ? `Port ${port} is used by another app, so webhooks can't be called right now.`
          : `Webhooks can't listen on port ${port} right now${err.code ? ` (${err.code})` : ''}.`;
      this.#o.log?.(`[webhooks] not listening: ${this.#problem}`);
      server.close();
      return;
    }
    server.on('error', () => undefined);
    const address = server.address();
    this.#server = server;
    this.#port = typeof address === 'object' && address ? address.port : port;
    this.#problem = null;
    this.#o.log?.(`[webhooks] listening on ${WEBHOOK_HOST}:${this.#port}`);
  }

  async #close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#port = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    this.#o.log?.('[webhooks] stopped listening');
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, ok: boolean, message: string, extra: Record<string, string> = {}): void => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
      res.end(JSON.stringify({ ok, message }));
    };
    try {
      if (req.method !== 'POST') return reply(405, false, MSG.usePost, { Allow: 'POST' });
      const m = PATH.exec((req.url ?? '').split('?')[0] ?? '');
      if (!m) return reply(404, false, MSG.noSuchWebhook);
      const cadenceId = m[1]!;
      const kind: WebhookCallKind = m[2] ? 'note' : 'run';
      if (!this.#o.secrets.refOf(cadenceId)) return reply(404, false, MSG.noSuchWebhook);

      const refuse = (status: number, refusal: string): void => {
        this.#tell({ cadenceId, kind, accepted: false, refusal, message: '' });
        reply(status, false, refusal, status === 413 ? { Connection: 'close' } : {});
      };

      const body = await readBody(req);
      if (body === null) return refuse(413, MSG.tooBig);
      if (!this.#allow(cadenceId)) return refuse(429, MSG.tooMany);
      const secret = this.#o.secrets.reveal(cadenceId);
      if (secret === null) return refuse(401, MSG.secretMissing);
      const check = checkSecret(req.headers, body, secret);
      if (check !== 'ok') return refuse(401, check === 'missing' ? MSG.noSecret : MSG.badSecret);

      const call = WebhookCallSchema.parse({ cadenceId, kind, accepted: true, refusal: null, message: webhookMessage(body) });
      let answer;
      try {
        answer = WebhookReplySchema.parse(await this.#o.call(call));
      } catch {
        return reply(503, false, MSG.hiveDown);
      }
      return reply(answer.status, answer.ok, answer.message);
    } catch {
      return reply(500, false, 'Something went wrong with this call.');
    }
  }

  /** Logs a refused call in the hive (the host keeps it to once a minute); never changes the answer. */
  #tell(call: WebhookCall): void {
    try {
      void this.#o.call(WebhookCallSchema.parse(call)).catch(() => undefined);
    } catch {
      // The hive isn't there to log it.
    }
  }

  /** At most WEBHOOK_MAX_CALLS_PER_MINUTE calls per webhook in any minute. */
  #allow(cadenceId: string): boolean {
    const now = this.#now();
    const recent = (this.#calls.get(cadenceId) ?? []).filter((t) => now - t < MINUTE);
    if (recent.length >= WEBHOOK_MAX_CALLS_PER_MINUTE) {
      this.#calls.set(cadenceId, recent);
      return false;
    }
    recent.push(now);
    this.#calls.set(cadenceId, recent);
    return true;
  }

  /** Where it is bound right now (always WEBHOOK_HOST), or null. */
  get address(): { address: string; port: number } | null {
    const a = this.#server?.address();
    return a && typeof a === 'object' ? { address: a.address, port: a.port } : null;
  }
}

/** The raw body, or null as soon as it passes WEBHOOK_MAX_BODY_BYTES (reading stops there). */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BODY_BYTES) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > WEBHOOK_MAX_BODY_BYTES) {
        req.off('data', onData);
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', reject);
  });
}
