import { type Socket, connect } from 'node:net';
import {
  BRAIN_ENV,
  type ErrorCode,
  type Identity,
  MAX_FRAME_BYTES,
  type Method,
  PROTOCOL_VERSION,
  type ParamsOf,
  type Results,
  type WireError,
} from './protocol';

/** An error from the Brain service, or from reaching it. `code` tells doors how to explain it. */
export class BrainServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BrainServiceError';
  }
}

export interface ConnectOptions {
  endpoint: string;
  token: string;
  /** Give up connecting or saying hello after this long. Default 5 s. */
  timeoutMs?: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/**
 * One authenticated connection to the Brain service. Calls are pipelined; the service answers
 * each with the same id. Lightweight: no dependency beyond node:net, so doors stay small.
 */
export class BrainClient {
  readonly identity: Identity;
  readonly #socket: Socket;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed: BrainServiceError | null = null;

  private constructor(socket: Socket, identity: Identity, rest: string) {
    this.#socket = socket;
    this.identity = identity;
    let buffer = rest;
    const drain = (): void => {
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) this.#onFrame(line);
      }
    };
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_FRAME_BYTES * 2) return this.#fail(new BrainServiceError('internal', 'Reply too large.'));
      drain();
    });
    socket.on('close', () => this.#fail(new BrainServiceError('disconnected', 'The Brain service closed the connection.')));
    socket.on('error', (e) => this.#fail(new BrainServiceError('disconnected', `Lost the Brain service: ${e.message}`)));
    drain();
  }

  static connect(opts: ConnectOptions): Promise<BrainClient> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    return new Promise((resolve, reject) => {
      const socket = connect(opts.endpoint);
      socket.setEncoding('utf8');
      let buffer = '';
      const done = (err: Error | null, client?: BrainClient): void => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('close', onClose);
        if (err) {
          socket.destroy();
          reject(err);
        } else resolve(client!);
      };
      const timer = setTimeout(
        () => done(new BrainServiceError('disconnected', `The Brain service did not answer within ${timeoutMs} ms.`)),
        timeoutMs,
      );
      const onError = (e: NodeJS.ErrnoException): void =>
        done(new BrainServiceError('disconnected', `Cannot reach the Brain service (${e.code ?? e.message}). Is the app running?`));
      const onClose = (): void => done(new BrainServiceError('disconnected', 'The Brain service closed the connection.'));
      const onData = (chunk: string): void => {
        buffer += chunk;
        const nl = buffer.indexOf('\n');
        if (nl < 0) return;
        let frame: { type?: string; identity?: Identity; error?: WireError };
        try {
          frame = JSON.parse(buffer.slice(0, nl)) as typeof frame;
        } catch {
          return done(new BrainServiceError('internal', 'Malformed reply from the Brain service.'));
        }
        if (frame.type === 'welcome' && frame.identity) return done(null, new BrainClient(socket, frame.identity, buffer.slice(nl + 1)));
        const e = frame.error ?? { code: 'internal' as const, message: 'Unexpected reply from the Brain service.' };
        done(new BrainServiceError(e.code, e.message, e.details));
      };
      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onClose);
      socket.once('connect', () => socket.write(`${JSON.stringify({ type: 'hello', v: PROTOCOL_VERSION, token: opts.token })}\n`));
    });
  }

  /** Connect with the endpoint and token the app put in the environment (INSECTOIDS_BRAIN_*). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env, timeoutMs?: number): Promise<BrainClient> {
    const endpoint = env[BRAIN_ENV.endpoint];
    const token = env[BRAIN_ENV.token];
    if (!endpoint || !token) {
      return Promise.reject(
        new BrainServiceError('unauthorized', `${BRAIN_ENV.endpoint} and ${BRAIN_ENV.token} are not set. The app sets them for each insect.`),
      );
    }
    return BrainClient.connect({ endpoint, token, ...(timeoutMs ? { timeoutMs } : {}) });
  }

  call<M extends Method>(method: M, params: ParamsOf<M>): Promise<Results[M]> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#socket.write(`${JSON.stringify({ type: 'call', id, method, params })}\n`);
    });
  }

  // Convenience wrappers, one per method.
  ping = () => this.call('ping', {});
  search = (p: ParamsOf<'search'>) => this.call('search', p);
  read = (p: ParamsOf<'read'>) => this.call('read', p);
  get = (id: string) => this.call('get', { id });
  history = (id: string) => this.call('history', { id });
  links = (id: string) => this.call('links', { id });
  bootCard = (p: ParamsOf<'bootCard'> = {}) => this.call('bootCard', p);
  write = (p: ParamsOf<'write'>) => this.call('write', p);
  update = (p: ParamsOf<'update'>) => this.call('update', p);
  archive = (id: string) => this.call('archive', { id });
  link = (p: ParamsOf<'link'>) => this.call('link', p);

  close(): void {
    this.#fail(new BrainServiceError('disconnected', 'Client closed.'));
  }

  #onFrame(line: string): void {
    let frame: { type?: string; id?: number | null; result?: unknown; error?: WireError };
    try {
      frame = JSON.parse(line) as typeof frame;
    } catch {
      return;
    }
    if (frame.type === 'error' && (frame.id === null || frame.id === undefined)) {
      // Connection-level error (e.g. token revoked): everything pending fails with it.
      const e = frame.error!;
      return this.#fail(new BrainServiceError(e.code, e.message, e.details));
    }
    const p = frame.id != null ? this.#pending.get(frame.id) : undefined;
    if (!p) return;
    this.#pending.delete(frame.id!);
    if (frame.type === 'result') p.resolve(frame.result);
    else if (frame.error) p.reject(new BrainServiceError(frame.error.code, frame.error.message, frame.error.details));
  }

  #fail(err: BrainServiceError): void {
    if (this.#closed) return;
    this.#closed = err;
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
    this.#socket.destroy();
  }
}
