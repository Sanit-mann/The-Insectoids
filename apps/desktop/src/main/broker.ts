import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Integration } from '@insectoids/shared';
import { type ServicesStore, isAllowedBase } from './services';

/**
 * The loopback secret broker (Connections 04-D4, Phase 2 step A3).
 *
 * Insects reach keyed services only through here: `POST http://127.0.0.1:<port>/call` with a capability
 * token. The broker checks the token, picks the integration by id (never a host), keeps the path inside
 * the integration's base URL, injects the key from the Vault, forwards, and returns a capped answer with
 * any echo of the key redacted. The insect never sees the key.
 *
 * A token is scoped to one card's run and to only the integrations that card needs; it's revoked when
 * the run ends and expires on its own after a hard TTL.
 */

export const DEFAULT_TTL_MS = 2 * 60 * 60_000;
export const MAX_BODY_BYTES = 200 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const TIMEOUT_MS = 30_000;
const AUDIT_MAX = 200;
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Method = (typeof METHODS)[number];
/** Caller headers that pass through; everything else (Authorization, Cookie, Host, Proxy-*, …) is dropped. */
const PASS_HEADERS = new Set(['accept', 'content-type']);
/** Response headers worth handing back (compact, nothing that identifies the user's session). */
const RETURN_HEADERS = ['content-type', 'link', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after'];

export interface BrokerGrant {
  cardId: string;
  runId?: string;
  agentId?: string;
  /** Integrations the card asked for. Only enabled, usable ones are granted. */
  integrations: string[];
  /** Approved "ask" rules for this card ("publish" lets write methods through). */
  approvedRules: string[];
}

export interface IssuedToken {
  url: string;
  token: string;
  granted: string[];
  denied: Array<{ id: string; reason: string }>;
}

export interface CallRequest {
  integration: string;
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
}

export type CallResult =
  | { ok: true; status: number; headers: Record<string, string>; body: string; truncated: boolean }
  | { ok: false; status: number; error: string };

export interface AuditEntry {
  at: number;
  cardId: string;
  integration: string;
  method: string;
  /** Path only; query values can carry secrets or personal data, so they're never kept. */
  path: string;
  status: number;
}

interface Live {
  grant: BrokerGrant;
  granted: Set<string>;
  expiresAt: number;
}

export interface BrokerDeps {
  services: ServicesStore;
  /** Decrypts a key at the moment it's injected (the Vault). */
  reveal: (ref: string) => string | null;
  fetch?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  /** Never receives a key: lines are built from ids, methods, paths and statuses only. */
  log?: (line: string) => void;
}

const fail = (status: number, error: string): CallResult => ({ ok: false, status, error });

/** A path that stays a path: starts with "/", no "//", no "\", no dot segments (raw or encoded), not a URL. */
export function checkPath(path: string): string | null {
  if (typeof path !== 'string' || !path.startsWith('/')) return 'The path must start with "/".';
  if (path.length > 2048) return 'The path is too long.';
  if (path.includes('//') || path.includes('\\')) return 'The path may not contain "//" or "\\".';
  if (/[\s?#]/.test(path)) return 'Put query values in "query", not in the path.';
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return 'The path has broken %-encoding.';
  }
  if (decoded.split('/').some((seg) => seg === '..' || seg === '.')) return 'The path may not contain "." or ".." segments.';
  if (decoded.includes('//') || decoded.includes('\\')) return 'The path may not contain "//" or "\\".';
  return null;
}

/** The final URL, guaranteed to stay on the integration's origin and under its base path. */
export function resolveUnderBase(baseUrl: string, path: string, query?: Record<string, string>): URL | null {
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/+$/, '');
  const url = new URL(`${prefix}${path}`, base.origin);
  if (url.origin !== base.origin) return null;
  if (prefix && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
  return url;
}

export class Broker {
  readonly #d: BrokerDeps;
  readonly #tokens = new Map<string, Live>();
  readonly #audit: AuditEntry[] = [];
  #server: Server | null = null;
  #url = '';

  constructor(d: BrokerDeps) {
    this.#d = d;
  }

  get url(): string {
    return this.#url;
  }

  async start(): Promise<string> {
    if (this.#server) return this.#url;
    const server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.#server = server;
    this.#url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return this.#url;
  }

  async close(): Promise<void> {
    this.#tokens.clear();
    const s = this.#server;
    this.#server = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /** Integrations switched on and usable right now (for the Queen's prompt). */
  available(): Array<{ id: string; description: string }> {
    return this.#d.services.all().filter((i) => this.#usable(i) === null).map((i) => ({ id: i.id, description: i.description }));
  }

  /** A capability token for one run: only the card's integrations that are on and have a key. */
  issue(g: BrokerGrant): IssuedToken {
    if (!this.#server) throw new Error('The secret broker is not running.');
    const granted: string[] = [];
    const denied: IssuedToken['denied'] = [];
    for (const id of [...new Set(g.integrations)]) {
      const i = this.#d.services.get(id);
      const why = i ? this.#usable(i) : 'unknown service';
      if (why) denied.push({ id, reason: why });
      else granted.push(id);
    }
    const token = randomBytes(32).toString('base64url');
    const now = this.#d.now?.() ?? Date.now();
    this.#tokens.set(token, { grant: g, granted: new Set(granted), expiresAt: now + (this.#d.ttlMs ?? DEFAULT_TTL_MS) });
    this.#d.log?.(`[broker] token for ${g.cardId}: ${granted.join(', ') || 'no services'}${denied.length ? ` (refused: ${denied.map((x) => x.id).join(', ')})` : ''}`);
    return { url: this.#url, token, granted, denied };
  }

  revoke(token: string): void {
    this.#tokens.delete(token);
  }

  /** Recent calls (no query values, no keys). */
  audit(): AuditEntry[] {
    return [...this.#audit];
  }

  /** A call with a capability token (what insects do). */
  async call(token: string, req: CallRequest): Promise<CallResult> {
    const live = this.#live(token);
    if (!live) return fail(401, 'This service token is not valid (it expired or its run ended).');
    if (!live.granted.has(req.integration)) {
      return fail(403, `This card may not use "${req.integration}". Cards only get the services they name, and only ones you switched on.`);
    }
    return this.#forward(req, live.grant.approvedRules, live.grant.cardId);
  }

  /** The user's own "Test" from the Services tab: one harmless read, no token. */
  async callAsUser(req: CallRequest): Promise<CallResult> {
    return this.#forward(req, [], 'user-test', true);
  }

  #live(token: string): Live | null {
    if (typeof token !== 'string' || !token) return null;
    // Constant-time compare against each live token (there are only a handful at a time).
    const now = this.#d.now?.() ?? Date.now();
    const given = Buffer.from(token);
    for (const [t, live] of this.#tokens) {
      const b = Buffer.from(t);
      if (b.length === given.length && timingSafeEqual(b, given)) {
        if (live.expiresAt <= now) {
          this.#tokens.delete(t);
          return null;
        }
        return live;
      }
    }
    return null;
  }

  /** null when usable; otherwise the plain-words reason. */
  #usable(i: Integration, ignoreEnabled = false): string | null {
    if (!ignoreEnabled && !i.enabled) return 'switched off';
    if (!isAllowedBase(i.baseUrl, this.#d.services.rules)) return 'its address is not allowed';
    if (i.authType !== 'none') {
      if (!i.secretRef) return 'no key chosen';
      if (this.#d.reveal(i.secretRef) === null) return 'its key is missing from the Vault';
    }
    return null;
  }

  async #forward(req: CallRequest, approvedRules: string[], cardId: string, asUser = false): Promise<CallResult> {
    const method = String(req.method ?? '').toUpperCase() as Method;
    const record = (status: number): void => {
      this.#audit.push({ at: this.#d.now?.() ?? Date.now(), cardId, integration: String(req.integration), method, path: String(req.path).slice(0, 300), status });
      if (this.#audit.length > AUDIT_MAX) this.#audit.shift();
    };
    const refuse = (status: number, error: string): CallResult => {
      record(status);
      return fail(status, error);
    };
    if (!(METHODS as readonly string[]).includes(method)) return refuse(400, `Method must be one of ${METHODS.join(', ')}.`);
    const i = this.#d.services.get(String(req.integration));
    if (!i) return refuse(404, `No service "${String(req.integration)}".`);
    const why = this.#usable(i, asUser);
    if (why) return refuse(403, `"${i.id}" can't be used: ${why}.`);
    if (!(i.readMethods as string[]).includes(method) && !approvedRules.includes('publish')) {
      return refuse(
        403,
        `${method} changes something on ${i.label} and needs the user's approval. Don't retry; end with "STATUS: BLOCKED: need approval to ${method} ${req.path} on ${i.label}".`,
      );
    }
    const pathError = checkPath(req.path);
    if (pathError) return refuse(400, pathError);
    if (req.query && (typeof req.query !== 'object' || Object.values(req.query).some((v) => typeof v !== 'string'))) {
      return refuse(400, 'Query values must be strings.');
    }
    const url = resolveUnderBase(i.baseUrl, req.path, req.query);
    if (!url) return refuse(400, `The path must stay under ${i.baseUrl}.`);

    const key = i.authType === 'none' ? null : i.secretRef ? this.#d.reveal(i.secretRef) : null;
    if (i.authType !== 'none' && !key) return refuse(403, `"${i.id}" has no usable key.`);
    const headers: Record<string, string> = { 'user-agent': 'The-Insectoids-broker', accept: 'application/json' };
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      if (PASS_HEADERS.has(k.toLowerCase()) && typeof v === 'string' && !/[\r\n]/.test(v)) headers[k.toLowerCase()] = v;
    }
    if (key && i.authType === 'bearer') headers['authorization'] = `Bearer ${key}`;
    if (key && i.authType === 'header' && i.authHeader) headers[i.authHeader.toLowerCase()] = key;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.#d.timeoutMs ?? TIMEOUT_MS);
    try {
      const res = await (this.#d.fetch ?? fetch)(url, {
        method,
        headers,
        ...(req.body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body: String(req.body) } : {}),
        redirect: 'manual',
        signal: ac.signal,
      });
      // Read a key's length past the cap, redact, then cut: a key split by the cap can't leak in part.
      const read = await readCapped(res, MAX_BODY_BYTES + (key?.length ?? 0));
      let body = redact(read.text, key);
      let truncated = read.truncated;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        body = Buffer.from(body).subarray(0, MAX_BODY_BYTES).toString('utf8');
        truncated = true;
      }
      if (key && truncated) body = redactPrefixAtEnd(body, key);
      const back: Record<string, string> = {};
      for (const h of RETURN_HEADERS) {
        const v = res.headers.get(h);
        if (v) back[h] = redact(v, key);
      }
      record(res.status);
      return { ok: true, status: res.status, headers: back, body, truncated };
    } catch (err) {
      const timedOut = (err as { name?: string })?.name === 'AbortError';
      this.#d.log?.(`[broker] ${i.id} ${method} ${req.path} failed${timedOut ? ' (timeout)' : ''}`);
      return refuse(502, timedOut ? `${i.label} did not answer within ${Math.round((this.#d.timeoutMs ?? TIMEOUT_MS) / 1000)} s.` : `Could not reach ${i.label}.`);
    } finally {
      clearTimeout(timer);
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method !== 'POST' || req.url !== '/call') return send(404, { ok: false, status: 404, error: 'Use POST /call.' });
      // Browsers can't reach this from a web page: no CORS headers, JSON only, and a bearer token is required.
      const auth = req.headers['authorization'];
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) return send(401, { ok: false, status: 401, error: 'A service token is required.' });
      if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
        return send(415, { ok: false, status: 415, error: 'Send JSON.' });
      }
      const raw = await readBody(req, MAX_REQUEST_BYTES);
      if (raw === null) return send(413, { ok: false, status: 413, error: 'The request is too large.' });
      let body: CallRequest;
      try {
        body = JSON.parse(raw) as CallRequest;
      } catch {
        return send(400, { ok: false, status: 400, error: 'The request is not valid JSON.' });
      }
      if (!body || typeof body !== 'object' || typeof body.integration !== 'string' || typeof body.path !== 'string' || typeof body.method !== 'string') {
        return send(400, { ok: false, status: 400, error: 'Give integration, method and path.' });
      }
      const result = await this.call(token, body);
      send(result.ok ? 200 : result.status, result);
    } catch {
      send(500, { ok: false, status: 500, error: 'The broker hit an error; the call was not made.' });
    }
  }
}

/** Every occurrence of the key in text becomes [REDACTED] (some APIs echo credentials in errors). */
export function redact(text: string, key: string | null): string {
  if (!key || key.length < 4) return text;
  return text.split(key).join('[REDACTED]');
}

/** If the cut text ends with the start of the key (4+ chars), drop that tail. */
function redactPrefixAtEnd(text: string, key: string): string {
  for (let n = Math.min(key.length - 1, text.length); n >= 4; n--) {
    if (text.endsWith(key.slice(0, n))) return `${text.slice(0, text.length - n)}[REDACTED]`;
  }
  return text;
}

async function readCapped(res: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) over = true;
      else if (!over) chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}
