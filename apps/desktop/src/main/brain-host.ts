import { randomBytes } from 'node:crypto';
import { type UtilityProcess, utilityProcess } from 'electron';
import { BrainClient, makeEndpoint } from '@insectoids/brain-service';
import type { BrainStatus, HivePush } from '@insectoids/shared';
import type { DoorPaths, FromHost, HiveSetup, HostMethod, ToHost } from '../brain-host/messages';

/** Restart delays after a crash: quick at first, then capped so a broken host doesn't spin. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** A host that stayed up this long counts as healthy again: the next crash restarts quickly. */
const HEALTHY_AFTER_MS = 60_000;
/** Give a starting host this long to open the Brain and listen. */
const START_TIMEOUT_MS = 20_000;
/** A host RPC that takes longer than this fails (the host keeps working; the UI re-reads on the next push). */
const RPC_TIMEOUT_MS = 30_000;

export const restartDelay = (attempt: number): number => BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;

export interface BrainHostOptions {
  /** The built utility entry (out/main/brain-host.js). */
  entry: string;
  dbPath: string;
  doors: DoorPaths;
  hive: HiveSetup;
  /** Hive pushes (changed / agent-output), forwarded to the window. */
  onPush?: (p: HivePush) => void;
  onStatus?: (s: BrainStatus) => void;
  log?: (line: string) => void;
}

/**
 * Runs the Brain host utility process and keeps it running. Main owns the endpoint and the master
 * token (handed over parentPort, never argv/env), and talks to the Brain only through the service.
 */
export class BrainHost {
  readonly endpoint = makeEndpoint();
  readonly #masterToken = randomBytes(32).toString('base64url');
  readonly #o: BrainHostOptions;
  #proc: UtilityProcess | null = null;
  #client: BrainClient | null = null;
  #status: BrainStatus = { state: 'starting', message: 'Starting the Brain…' };
  #attempt = 0;
  #readyAt = 0;
  #stopping = false;
  #retry: NodeJS.Timeout | null = null;
  #startTimer: NodeJS.Timeout | null = null;
  #rpcId = 0;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(o: BrainHostOptions) {
    this.#o = o;
  }

  get status(): BrainStatus {
    return this.#status;
  }

  /** The app's own connection, as the user (master token). Null until ready. */
  get client(): BrainClient | null {
    return this.#client;
  }

  start(): void {
    if (this.#proc || this.#stopping) return;
    this.#set({ state: 'starting', message: this.#attempt ? 'Restarting the Brain…' : 'Starting the Brain…' });
    const proc = utilityProcess.fork(this.#o.entry, [], { serviceName: 'Insectoids Brain', stdio: 'pipe' });
    this.#proc = proc;
    proc.stdout?.on('data', (d: Buffer) => this.#o.log?.(`[brain] ${d.toString().trimEnd()}`));
    proc.stderr?.on('data', (d: Buffer) => this.#o.log?.(`[brain] ${d.toString().trimEnd()}`));
    proc.on('message', (m: FromHost) => void this.#onMessage(m));
    proc.on('exit', (code) => this.#onExit(proc, code));
    proc.once('spawn', () => {
      const msg: ToHost = { type: 'start', dbPath: this.#o.dbPath, endpoint: this.endpoint, masterToken: this.#masterToken, doors: this.#o.doors, hive: this.#o.hive };
      proc.postMessage(msg);
    });
    this.#startTimer = setTimeout(() => {
      if (this.#status.state === 'starting') {
        this.#o.log?.('[brain] did not become ready in time; restarting');
        proc.kill();
      }
    }, START_TIMEOUT_MS);
  }

  /** Clean shutdown: the host closes the service and the database, then exits. */
  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#retry) clearTimeout(this.#retry);
    this.#clearStartTimer();
    this.#client?.close();
    this.#client = null;
    const proc = this.#proc;
    if (!proc) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill();
        resolve();
      }, 3_000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      const msg: ToHost = { type: 'stop' };
      proc.postMessage(msg);
    });
  }

  /** Call the hive in the host (typed RPC over parentPort). Rejects when the host is down or slow. */
  call(method: HostMethod, params?: unknown): Promise<unknown> {
    const proc = this.#proc;
    if (!proc || this.#status.state !== 'ready') return Promise.reject(new Error(this.#status.message));
    const id = ++this.#rpcId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`The hive did not answer within ${RPC_TIMEOUT_MS / 1000} s.`));
      }, RPC_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      const msg: ToHost = { type: 'rpc', id, method, ...(params === undefined ? {} : { params }) };
      proc.postMessage(msg);
    });
  }

  async #onMessage(m: FromHost): Promise<void> {
    if (m.type === 'push') {
      this.#o.onPush?.(m.push);
      return;
    }
    if (m.type === 'rpc-result') {
      const p = this.#pending.get(m.id);
      if (!p) return;
      this.#pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error));
      return;
    }
    if (m.type === 'failed') {
      this.#o.log?.(`[brain] failed to start: ${m.message}`);
      this.#set({ state: 'failed', message: `The Brain could not start: ${m.message}` });
      this.#proc?.kill();
      return;
    }
    if (m.type !== 'ready') return;
    this.#clearStartTimer();
    try {
      // Prove the service answers, as the user, before saying "ready".
      this.#client?.close();
      this.#client = await BrainClient.connect({ endpoint: this.endpoint, token: this.#masterToken });
      await this.#client.ping();
      this.#readyAt = Date.now();
      this.#set({ state: 'ready', message: 'The Brain is running.' });
    } catch (err) {
      this.#set({ state: 'failed', message: `The Brain started but does not answer: ${err instanceof Error ? err.message : String(err)}` });
      this.#proc?.kill();
    }
  }

  #onExit(proc: UtilityProcess, code: number): void {
    if (this.#proc !== proc) return;
    this.#proc = null;
    this.#clearStartTimer();
    this.#client?.close();
    this.#client = null;
    this.#failPending('The Brain host stopped.');
    if (this.#stopping) return;
    if (this.#readyAt && Date.now() - this.#readyAt > HEALTHY_AFTER_MS) this.#attempt = 0;
    this.#readyAt = 0;
    const delay = restartDelay(this.#attempt++);
    const why = this.#status.state === 'failed' ? this.#status.message : `The Brain stopped unexpectedly (exit ${code}).`;
    this.#set({ state: 'failed', message: `${why} Retrying in ${Math.round(delay / 1000)} s.` });
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.start();
    }, delay);
  }

  #failPending(message: string): void {
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.#pending.clear();
  }

  #clearStartTimer(): void {
    if (this.#startTimer) clearTimeout(this.#startTimer);
    this.#startTimer = null;
  }

  #set(s: BrainStatus): void {
    this.#status = s;
    this.#o.onStatus?.(s);
  }
}
