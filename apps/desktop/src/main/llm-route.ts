import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProvidersStore } from './providers';

/**
 * The broker's LLM route (Connections 04-D3/D4, Phase 2 step A4): `/llm/<providerId>/<path>`, OpenAI-compatible.
 *
 * An engine (OpenCode) is told the provider lives at `http://127.0.0.1:<port>/llm/<id>` and gets a short-lived
 * per-run **pass** as its "API key". The broker checks the pass, swaps in the real key from the Vault (none for
 * local servers), forwards to the provider, and streams the answer straight back. So a provider key never
 * enters an engine process, an MCP server or a shell.
 *
 * The route also records, per pass, the model that actually answered and the tokens used: the hive's source of
 * truth for "model actually used" (04 design 3), since some engines don't report it.
 */

/** Paths under the provider's base an engine may call. Exact matches only: no traversal is possible. */
export const LLM_PATHS: ReadonlySet<string> = new Set(['/chat/completions', '/completions', '/models', '/responses', '/embeddings']);
export const LLM_TTL_MS = 2 * 60 * 60_000;
export const LLM_TIMEOUT_MS = 10 * 60_000;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
/** JSON (non-streamed) bodies are parsed for usage up to this size. */
const MAX_PARSE_BYTES = 4 * 1024 * 1024;
/** Calls waiting behind the one in flight, per pass. */
const MAX_QUEUE = 8;
const RETIRED_MAX = 100;
const ID = /^[a-z][a-z0-9-]{1,31}$/;
/** Caller headers that pass through; everything else (Authorization, Cookie, Host, …) is dropped. */
const PASS_HEADERS = ['content-type', 'accept'];
const RETURN_HEADERS = ['content-type', 'retry-after', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests'];

export interface LlmUsage {
  /** The model the provider says answered (or the one asked for, when it doesn't say). */
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  calls: number;
}

interface Pass {
  providerId: string;
  runId: string;
  expiresAt: number;
  usage: LlmUsage;
  /** Serialises calls: one request in flight per pass. */
  tail: Promise<void>;
  queued: number;
}

export interface LlmRouteDeps {
  providers: ProvidersStore;
  reveal: (ref: string) => string | null;
  hasKey: (ref: string) => boolean;
  fetch?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  /** Never receives a key or a pass: ids, paths and statuses only. */
  log?: (line: string) => void;
}

export type LlmUserResult = { ok: true; status: number; body: string } | { ok: false; status: number | null; error: string };

const emptyUsage = (): LlmUsage => ({ model: null, input: 0, output: 0, cacheRead: 0, calls: 0 });
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** Adds one response's model and usage (OpenAI chat/completions or /responses shapes) to a pass's log. */
export function addUsage(u: LlmUsage, event: unknown): void {
  if (!event || typeof event !== 'object') return;
  const e = event as Record<string, unknown>;
  const r = (e['response'] && typeof e['response'] === 'object' ? e['response'] : e) as Record<string, unknown>;
  if (typeof r['model'] === 'string' && r['model']) u.model = r['model'];
  const usage = r['usage'] as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return;
  u.input += num(usage['prompt_tokens'] ?? usage['input_tokens']);
  u.output += num(usage['completion_tokens'] ?? usage['output_tokens']);
  const details = (usage['prompt_tokens_details'] ?? usage['input_tokens_details']) as Record<string, unknown> | undefined;
  u.cacheRead += num(details?.['cached_tokens'] ?? usage['cache_read_input_tokens']);
}

/**
 * Streaming redaction: every occurrence of the key becomes [REDACTED], even when it is split across chunks.
 * It holds back the last (key length − 1) characters until the next chunk or the end.
 */
export function streamRedactor(key: string | null): { push(text: string): string; end(): string } {
  if (!key || key.length < 4) return { push: (t) => t, end: () => '' };
  let carry = '';
  return {
    push(text) {
      const s = (carry + text).split(key).join('[REDACTED]');
      const keep = Math.min(s.length, key.length - 1);
      carry = s.slice(s.length - keep);
      return s.slice(0, s.length - keep);
    },
    end() {
      const c = carry;
      carry = '';
      return c;
    },
  };
}

/** Reads `data: {...}` SSE events as they stream past, for model and usage. */
function sseWatcher(onEvent: (e: unknown) => void): (text: string) => void {
  let buf = '';
  return (text) => {
    buf += text;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        onEvent(JSON.parse(data));
      } catch {
        // Not JSON: nothing to record.
      }
    }
    if (buf.length > 1_000_000) buf = '';
  };
}

export class LlmRoute {
  readonly #d: LlmRouteDeps;
  readonly #passes = new Map<string, Pass>();
  readonly #retired = new Map<string, LlmUsage>();

  constructor(d: LlmRouteDeps) {
    this.#d = d;
  }

  /** A pass for one engine run, scoped to one provider. Throws (plain words) when the provider can't be used. */
  issue(o: { runId: string; providerId: string }, brokerUrl: string): { baseUrl: string; pass: string } {
    if (!brokerUrl) throw new Error('The secret broker is not running.');
    const p = this.#d.providers.get(o.providerId);
    if (!p) throw new Error(`No provider "${o.providerId}".`);
    const why = this.#d.providers.unusable(p, this.#d.hasKey);
    if (why) throw new Error(`${p.label} can't be used: ${why}.`);
    const pass = `llm_${randomBytes(32).toString('base64url')}`;
    this.#passes.set(pass, {
      providerId: p.id,
      runId: o.runId,
      expiresAt: this.#now() + (this.#d.ttlMs ?? LLM_TTL_MS),
      usage: emptyUsage(),
      tail: Promise.resolve(),
      queued: 0,
    });
    this.#d.log?.(`[broker] llm pass for run ${o.runId}: ${p.id}`);
    return { baseUrl: `${brokerUrl}/llm/${p.id}`, pass };
  }

  /** Model and tokens recorded for a pass (live, or revoked recently). */
  usage(pass: string): LlmUsage {
    const live = this.#passes.get(pass);
    if (live) return { ...live.usage };
    const old = this.#retired.get(pass);
    if (old) return { ...old };
    throw new Error('Unknown pass.');
  }

  /** Ends a pass; its usage stays readable for a while. Returns whether it was an LLM pass. */
  revoke(pass: string): boolean {
    const live = this.#passes.get(pass);
    if (!live) return false;
    this.#passes.delete(pass);
    this.#retired.set(pass, live.usage);
    while (this.#retired.size > RETIRED_MAX) this.#retired.delete(this.#retired.keys().next().value!);
    return true;
  }

  /** Whether a live pass uses the provider (a run is going on): it can't be switched off or removed now. */
  inUse(providerId: string): boolean {
    const now = this.#now();
    for (const p of this.#passes.values()) if (p.providerId === providerId && p.expiresAt > now) return true;
    return false;
  }

  clear(): void {
    this.#passes.clear();
    this.#retired.clear();
  }

  /** The user's own "Test" from the API providers tab: GET /models, no pass, a capped answer. */
  async callAsUser(providerId: string, path: '/models'): Promise<LlmUserResult> {
    const p = this.#d.providers.get(providerId);
    if (!p) return { ok: false, status: null, error: `No provider "${providerId}".` };
    const why = this.#d.providers.unusable({ ...p, enabled: true }, this.#d.hasKey);
    if (why) return { ok: false, status: null, error: `${p.label} can't be used: ${why}.` };
    const key = p.secretRef ? this.#d.reveal(p.secretRef) : null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    try {
      const res = await this.#upstream(p.baseUrl, path, 'GET', undefined, { accept: 'application/json' }, key, ac.signal);
      const text = await readCapped(res, MAX_PARSE_BYTES);
      return { ok: true, status: res.status, body: redactAll(text, key) };
    } catch (err) {
      const timedOut = (err as { name?: string })?.name === 'AbortError';
      return { ok: false, status: null, error: timedOut ? `${p.label} did not answer within 30 s.` : `Could not reach ${p.label}.` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Handles one `/llm/…` request from an engine. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, message: string): void => {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: { message, type: 'insectoids_broker' } }));
    };
    const raw = req.url ?? '';
    if (raw.includes('?') || raw.includes('#')) return json(400, 'The LLM route takes no query string.');
    const m = /^\/llm\/([^/]+)(\/.*)$/.exec(raw);
    if (!m || !ID.test(m[1]!)) return json(404, 'Use /llm/<provider>/<path>.');
    const providerId = m[1]!;
    const path = m[2]!;
    if (!LLM_PATHS.has(path)) return json(404, `Only ${[...LLM_PATHS].join(', ')} are allowed.`);
    const auth = req.headers['authorization'];
    const given = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const pass = this.#live(given);
    if (!pass) return json(401, 'This pass is not valid (it expired or its run ended).');
    if (pass.providerId !== providerId) return json(403, 'This pass is for another provider.');
    const method = (req.method ?? '').toUpperCase();
    const wanted = path === '/models' ? 'GET' : 'POST';
    if (method !== wanted) return json(405, `${path} takes ${wanted}.`);
    const body = method === 'POST' ? await readBody(req, MAX_REQUEST_BYTES) : '';
    if (body === null) return json(413, 'The request is too large.');
    if (pass.queued >= MAX_QUEUE) return json(429, 'Too many calls waiting for this run.');

    pass.queued++;
    const run = pass.tail.then(() => this.#forward(pass, path, method, body, req, res, json));
    pass.tail = run.catch(() => {});
    try {
      await run;
    } finally {
      pass.queued--;
    }
  }

  async #forward(
    pass: Pass,
    path: string,
    method: string,
    body: string,
    req: IncomingMessage,
    res: ServerResponse,
    json: (status: number, message: string) => void,
  ): Promise<void> {
    const p = this.#d.providers.get(pass.providerId);
    const why = p ? this.#d.providers.unusable(p, this.#d.hasKey) : 'removed';
    if (!p || why) return json(403, `This provider can't be used now: ${why}.`);
    if (res.destroyed) return;
    const key = p.secretRef ? this.#d.reveal(p.secretRef) : null;
    if (p.secretRef && !key) return json(403, `${p.label} has no usable key.`);

    let requestedModel: string | null = null;
    if (body) {
      try {
        const parsed = JSON.parse(body) as { model?: unknown };
        if (typeof parsed.model === 'string') requestedModel = parsed.model;
      } catch {
        // The provider decides what a bad body means.
      }
    }
    const headers: Record<string, string> = {};
    for (const h of PASS_HEADERS) {
      const v = req.headers[h];
      if (typeof v === 'string' && !/[\r\n]/.test(v)) headers[h] = v;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.#d.timeoutMs ?? LLM_TIMEOUT_MS);
    // The engine hung up: stop the provider's stream too.
    const onClose = (): void => ac.abort();
    res.on('close', onClose);
    const usage = pass.usage;
    usage.calls++;
    if (requestedModel) usage.model = requestedModel;
    try {
      const up = await this.#upstream(p.baseUrl, path, method, body || undefined, headers, key, ac.signal);
      const back: Record<string, string> = { 'cache-control': 'no-store' };
      for (const h of RETURN_HEADERS) {
        const v = up.headers.get(h);
        if (v) back[h] = redactAll(v, key);
      }
      res.writeHead(up.status, back);
      const sse = (up.headers.get('content-type') ?? '').includes('text/event-stream');
      const watch = sse ? sseWatcher((e) => addUsage(usage, e)) : null;
      let parseBuf = sse ? null : '';
      const redactor = streamRedactor(key);
      const decoder = new TextDecoder();
      if (up.body) {
        const reader = up.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          watch?.(text);
          if (parseBuf !== null) parseBuf = parseBuf.length + text.length <= MAX_PARSE_BYTES ? parseBuf + text : null;
          const out = redactor.push(text);
          if (out && !res.write(out)) await new Promise<void>((r) => res.once('drain', () => r()));
        }
        const rest = redactor.push(decoder.decode()) + redactor.end();
        if (rest) res.write(rest);
      }
      res.end();
      if (parseBuf) {
        try {
          addUsage(usage, JSON.parse(parseBuf));
        } catch {
          // Not JSON: nothing to record.
        }
      }
      this.#d.log?.(`[broker] llm ${p.id} ${method} ${path} ${up.status}`);
    } catch (err) {
      const timedOut = (err as { name?: string })?.name === 'AbortError';
      this.#d.log?.(`[broker] llm ${p.id} ${method} ${path} failed${timedOut ? ' (aborted)' : ''}`);
      if (!res.destroyed) json(502, timedOut ? `${p.label} did not answer in time, or the call was cancelled.` : `Could not reach ${p.label}.`);
    } finally {
      clearTimeout(timer);
      res.off('close', onClose);
    }
  }

  #upstream(
    baseUrl: string,
    path: string,
    method: string,
    body: string | undefined,
    headers: Record<string, string>,
    key: string | null,
    signal: AbortSignal,
  ): Promise<Response> {
    const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
    const h: Record<string, string> = { 'user-agent': 'The-Insectoids-broker', ...headers };
    if (key) h['authorization'] = `Bearer ${key}`;
    return (this.#d.fetch ?? fetch)(url, { method, headers: h, ...(body !== undefined ? { body } : {}), redirect: 'manual', signal });
  }

  #live(given: string): Pass | null {
    if (!given) return null;
    const now = this.#now();
    const g = Buffer.from(given);
    for (const [t, pass] of this.#passes) {
      const b = Buffer.from(t);
      if (b.length === g.length && timingSafeEqual(b, g)) {
        if (pass.expiresAt <= now) {
          this.revoke(t);
          return null;
        }
        return pass;
      }
    }
    return null;
  }

  #now(): number {
    return this.#d.now?.() ?? Date.now();
  }
}

function redactAll(text: string, key: string | null): string {
  return key && key.length >= 4 ? text.split(key).join('[REDACTED]') : text;
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size));
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return Buffer.concat(chunks).toString('utf8');
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
