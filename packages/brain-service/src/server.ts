import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server, type Socket, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Actor, type Brain, ConflictError, SecretError, TrustError } from '@insectoids/brain';
import {
  CallFrame,
  type ErrorCode,
  HELLO_TIMEOUT_MS,
  HelloFrame,
  type Identity,
  MAX_FRAME_BYTES,
  type Method,
  PROTOCOL_VERSION,
  Params,
  type Results,
  type ServerFrame,
  USER_METHODS,
  WRITE_METHODS,
  isMethod,
} from './protocol';

const GLOBAL_SHELF = 'global';

export interface BrainServiceOptions {
  /** The one Brain this process writes (single writer, 01-D14). */
  brain: Brain;
  /** Pipe or socket path. Default: a fresh private one (see `makeEndpoint`). */
  endpoint?: string;
  /** The user's token. Default: a fresh random one. Keep it inside the app; never hand it to an insect. */
  masterToken?: string;
  /**
   * Meaning search (Phase 2 B1): turns a search's query text into a vector, in this process (the Brain
   * host's embedder). Null when meaning search is off or not ready; then search uses words only.
   * Callers never send vectors themselves.
   */
  embedQuery?: (text: string) => Promise<{ vector: Float32Array; model: string } | null>;
}

export interface AgentGrant {
  agentId: string;
  /** The project shelf the agent may read (plus global) and write. */
  shelf: string;
  write: boolean;
}

export interface BrainService {
  readonly endpoint: string;
  readonly masterToken: string;
  /** A token for one insect run: bound to its agent id, project shelf and read/write. */
  issueAgentToken(grant: AgentGrant): string;
  revokeToken(token: string): void;
  close(): Promise<void>;
}

export class ServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/**
 * A fresh local endpoint: a named pipe on Windows; elsewhere a Unix socket inside a new folder
 * only this user can open (mkdtemp makes it 0700). Short, because Unix socket paths max out near 104 bytes.
 */
export function makeEndpoint(): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\insectoids-brain-${randomUUID()}`;
  return join(mkdtempSync(join(tmpdir(), 'insb-')), 'brain.sock');
}

const newToken = (): string => randomBytes(32).toString('base64url');
const tokenKey = (token: string): string => createHash('sha256').update(token).digest('hex');

export async function startBrainService(opts: BrainServiceOptions): Promise<BrainService> {
  const { brain } = opts;
  const endpoint = opts.endpoint ?? makeEndpoint();
  const masterToken = opts.masterToken ?? newToken();
  /** sha256(token) -> identity. Raw tokens are never stored. */
  const tokens = new Map<string, Identity>([[tokenKey(masterToken), { type: 'user' }]]);
  const sockets = new Set<Socket>();

  const issueAgentToken = (grant: AgentGrant): string => {
    const shelf = Params['admin.issueToken'].parse(grant).shelf;
    const token = newToken();
    tokens.set(tokenKey(token), { type: 'agent', id: grant.agentId, shelf, write: grant.write });
    return token;
  };

  const revokeToken = (token: string): void => {
    const key = tokenKey(token);
    if (tokens.get(key)?.type === 'user') throw new ServiceError('forbidden', 'The master token cannot be revoked.');
    tokens.delete(key);
    // Connections already opened with the token are closed too.
    for (const s of sockets) if (connTokenKey.get(s) === key) s.destroy();
  };

  const connTokenKey = new WeakMap<Socket, string>();

  // ---- method handlers -------------------------------------------------------------------------

  const actorOf = (who: Identity): Actor => (who.type === 'user' ? { type: 'user' } : { type: 'agent', id: who.id });
  const visible = (who: Identity, shelf: string): boolean =>
    who.type === 'user' || shelf === who.shelf || shelf === GLOBAL_SHELF;

  /** The record, if this identity may see it. Other projects' records look exactly like missing ones. */
  const seeRecord = (who: Identity, id: string) => {
    const rec = brain.get(id);
    if (!rec || !visible(who, rec.shelf)) throw new ServiceError('not_found', `No Brain record ${id}`);
    return rec;
  };

  /** Agents change only records on their own project shelf; global is the user's. */
  const mayChange = (who: Identity, id: string): void => {
    const rec = seeRecord(who, id);
    if (who.type === 'agent' && rec.shelf !== who.shelf) {
      throw new ServiceError('forbidden', `${id} is on the ${rec.shelf} shelf; agents may only change their project's records.`);
    }
  };

  const agentShelf = (who: Identity, requested: string | undefined): string | undefined => {
    if (who.type === 'user') return requested;
    if (requested && requested !== who.shelf && requested !== GLOBAL_SHELF) {
      throw new ServiceError('forbidden', `This token is limited to the ${who.shelf} shelf.`);
    }
    return who.shelf;
  };

  /** The query's meaning vector, if meaning search is on. A failing embedder only costs the meaning part. */
  const meaning = async (query: string): Promise<{ queryVector: Float32Array; vectorModel: string } | Record<string, never>> => {
    if (!opts.embedQuery) return {};
    try {
      const v = await opts.embedQuery(query);
      return v ? { queryVector: v.vector, vectorModel: v.model } : {};
    } catch {
      return {};
    }
  };

  const handlers: { [M in Method]: (p: ReturnType<(typeof Params)[M]['parse']>, who: Identity) => Results[M] | Promise<Results[M]> } = {
    ping: (_p, who) => ({ v: PROTOCOL_VERSION, identity: who }),
    search: async (p, who) => {
      const shelf = agentShelf(who, p.shelf);
      const m = await meaning(p.query);
      return brain.search(p.query, { ...(shelf ? { shelf } : {}), ...(p.kinds ? { kinds: p.kinds } : {}), ...(p.limit ? { limit: p.limit } : {}), ...m });
    },
    read: async (p, who) => {
      const shelf = agentShelf(who, p.shelf);
      const m = await meaning(p.query);
      return brain.read(p.query, {
        ...(shelf ? { shelf } : {}),
        ...(p.kinds ? { kinds: p.kinds } : {}),
        ...(p.tokenBudget ? { tokenBudget: p.tokenBudget } : {}),
        ...m,
      });
    },
    get: (p, who) => {
      const rec = brain.get(p.id);
      return rec && visible(who, rec.shelf) ? rec : null;
    },
    history: (p, who) => (seeRecord(who, p.id), brain.history(p.id)),
    links: (p, who) => {
      seeRecord(who, p.id);
      return brain.links(p.id).filter((l) => {
        const other = brain.get(l.id);
        return other !== undefined && visible(who, other.shelf);
      });
    },
    bootCard: (p, who) => {
      const shelf = who.type === 'agent' ? who.shelf : p.shelf;
      if (!shelf) throw new ServiceError('bad_request', 'bootCard needs a shelf.');
      return { text: brain.bootCard(shelf) };
    },
    write: (p, who) => {
      const shelf = who.type === 'agent' ? who.shelf : p.shelf;
      if (who.type === 'agent' && p.shelf && p.shelf !== who.shelf) {
        throw new ServiceError('forbidden', `This token writes only to the ${who.shelf} shelf.`);
      }
      if (!shelf) throw new ServiceError('bad_request', 'write needs a shelf.');
      return brain.write({ ...p, shelf } as Parameters<Brain['write']>[0], actorOf(who));
    },
    update: (p, who) => {
      mayChange(who, p.id);
      const { id, ...changes } = p;
      return { version: brain.update(id, changes as Parameters<Brain['update']>[1], actorOf(who)) };
    },
    archive: (p, who) => {
      mayChange(who, p.id);
      brain.archive(p.id, actorOf(who));
      return { ok: true };
    },
    link: (p, who) => {
      mayChange(who, p.from);
      seeRecord(who, p.to);
      brain.link(p.from, p.to, p.rel);
      return { ok: true };
    },
    'admin.issueToken': (p) => ({ token: issueAgentToken(p) }),
    'admin.revokeToken': (p) => (revokeToken(p.token), { ok: true }),
  };

  const dispatch = (method: string, rawParams: unknown, who: Identity): unknown => {
    if (!isMethod(method)) throw new ServiceError('bad_request', `Unknown method ${method}`);
    if (USER_METHODS.has(method) && who.type !== 'user') throw new ServiceError('forbidden', `${method} is for the app only.`);
    if (WRITE_METHODS.has(method) && who.type === 'agent' && !who.write) {
      throw new ServiceError('forbidden', 'This token is read-only.');
    }
    const parsed = Params[method].safeParse(rawParams ?? {});
    if (!parsed.success) {
      throw new ServiceError('bad_request', parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; '));
    }
    return (handlers[method] as (p: unknown, w: Identity) => unknown)(parsed.data, who);
  };

  const toWire = (err: unknown): { code: ErrorCode; message: string; details?: Record<string, unknown> } => {
    if (err instanceof ServiceError) return { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) };
    if (err instanceof SecretError) return { code: 'secret', message: err.message, details: { kinds: err.kinds } };
    if (err instanceof TrustError) return { code: 'trust', message: err.message };
    if (err instanceof ConflictError) return { code: 'conflict', message: err.message };
    const message = err instanceof Error ? err.message : String(err);
    if (/^No Brain record /.test(message)) return { code: 'not_found', message };
    return { code: 'internal', message };
  };

  // ---- connections -----------------------------------------------------------------------------

  const onConnection = (socket: Socket): void => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let who: Identity | null = null;
    let buffer = '';
    const send = (frame: ServerFrame): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
    };
    const fail = (code: ErrorCode, message: string): void => {
      send({ type: 'error', id: null, error: { code, message } });
      socket.end();
    };
    const helloTimer = setTimeout(() => fail('unauthorized', 'No hello received.'), HELLO_TIMEOUT_MS);

    const onFrame = (line: string): void => {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        return fail('bad_request', 'Frames must be one JSON object per line.');
      }
      if (!who) {
        const hello = HelloFrame.safeParse(json);
        if (!hello.success) return fail('unauthorized', 'The first frame must be hello with a token.');
        if (hello.data.v !== PROTOCOL_VERSION) return fail('bad_request', `Protocol ${hello.data.v} not supported; this service speaks ${PROTOCOL_VERSION}.`);
        const key = tokenKey(hello.data.token);
        const identity = tokens.get(key);
        if (!identity) return fail('unauthorized', 'Unknown or revoked token.');
        clearTimeout(helloTimer);
        who = identity;
        connTokenKey.set(socket, key);
        return send({ type: 'welcome', v: PROTOCOL_VERSION, identity });
      }
      const call = CallFrame.safeParse(json);
      if (!call.success) return send({ type: 'error', id: null, error: { code: 'bad_request', message: 'Expected a call frame.' } });
      // A token revoked mid-connection stops working at once.
      if (!tokens.has(connTokenKey.get(socket)!)) return fail('unauthorized', 'Token revoked.');
      // Searches may wait for the query's meaning vector; everything else answers at once. Writes stay
      // synchronous, so the single writer still applies them in arrival order.
      const id = call.data.id;
      try {
        const result = dispatch(call.data.method, call.data.params, who);
        if (result instanceof Promise) {
          result.then(
            (r) => send({ type: 'result', id, result: r }),
            (err: unknown) => send({ type: 'error', id, error: toWire(err) }),
          );
        } else {
          send({ type: 'result', id, result });
        }
      } catch (err) {
        send({ type: 'error', id, error: toWire(err) });
      }
    };

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_FRAME_BYTES && !buffer.includes('\n')) return fail('bad_request', 'Frame too large.');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length > MAX_FRAME_BYTES) return fail('bad_request', 'Frame too large.');
        if (line) onFrame(line);
        if (socket.destroyed || socket.writableEnded) return;
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      clearTimeout(helloTimer);
      sockets.delete(socket);
    });
  };

  const server: Server = createServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    endpoint,
    masterToken,
    issueAgentToken,
    revokeToken,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => {
          if (process.platform !== 'win32' && dirname(endpoint).includes('insb-')) rmSync(dirname(endpoint), { recursive: true, force: true });
          resolve();
        });
      }),
  };
}
