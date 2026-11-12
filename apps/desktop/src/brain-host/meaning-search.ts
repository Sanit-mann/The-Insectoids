/**
 * Meaning search in the Brain host (Memory 01-E11; Phase 2 B1).
 *
 * - Off by default. Switching it on downloads the model once (pinned revision, every file checked against
 *   its checksum) if it isn't on this PC yet, then loads it and indexes the Brain in the background.
 * - Records are embedded one at a time (batch 1: the quantized model's vectors shift with their batch
 *   neighbours), newest first, between other work. Brain writes never wait for it.
 * - Searches through the Brain service (the app, MCP, the `brain` CLI) and the Queen's related-records lookup
 *   get the query's vector from here; agents never send vectors.
 * - Switching it off unloads the model and keeps the vectors, so switching back on only indexes what changed.
 * - Nothing about the Brain leaves this PC: the model runs in WebAssembly, in this process.
 *
 * Electron-free (tests run it in plain Node). The WebAssembly runtime is imported only when the model loads.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Brain } from '@insectoids/brain';
import { type DownloadOptions, downloadModel, isModelPresent, modelDir } from '@insectoids/embeddings/download';
import { DEFAULT_MODEL, type EmbeddingModel, MODELS, modelSize } from '@insectoids/embeddings/models';
import type { MeaningSearch as MeaningSearchView } from '@insectoids/shared';

/** What the embedder must do (the real one is OnnxEmbedder; tests pass a fake). */
export interface QueryEmbedder {
  readonly modelId: string;
  embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]>;
  dispose(): Promise<void>;
}

export interface MeaningSearchOptions {
  brain: Brain;
  /** `<userData>/meaning-search.json`: whether the user switched it on. */
  settingsFile: string;
  /** Where models live: `<dir>/<repo name>/<revision>/`. */
  modelsDir: string;
  /** onnxruntime-web's WASM folder (resolved by main; see doors.ts). */
  wasmDir?: string;
  /** Something changed that the window should re-read (throttled here). */
  onChange: () => void;
  log?: (line: string) => void;
  // Test seams.
  model?: EmbeddingModel;
  isPresent?: (dir: string, m: EmbeddingModel) => Promise<boolean>;
  download?: (m: EmbeddingModel, o: DownloadOptions) => Promise<string>;
  loadEmbedder?: (m: EmbeddingModel, dir: string, wasmDir?: string) => Promise<QueryEmbedder>;
  /** Pause between records (ms). Default 5. */
  yieldMs?: number;
  /** How often to look for new or changed records when everything is indexed (ms). Default 3000. */
  idleMs?: number;
}

type State = MeaningSearchView['state'];

const mb = (bytes: number): number => Math.round(bytes / 1e5) / 10;

/**
 * The view of meaning search while it is off: `off` when the model is already on this PC, `needs-download`
 * when switching on would download it first (the UI shows the size and source before the user agrees).
 */
export function meaningSearchOffView(m: EmbeddingModel = MODELS[DEFAULT_MODEL], present = false): MeaningSearchView {
  return {
    state: present ? 'off' : 'needs-download',
    model: m.id,
    sizeMb: mb(modelSize(m)),
    source: sourceText(m),
    progress: 0,
    indexed: 0,
    total: 0,
    message: offMessage(m, present),
  };
}

/**
 * Tests must never download the model (e2e profiles are throwaway; a download there costs 24 MB of the
 * user's bandwidth each run). Under INSECTOIDS_E2E=1 or vitest, downloading needs an explicit
 * INSECTOIDS_ALLOW_MODEL_DOWNLOAD=1; e2e points INSECTOIDS_E2E_MODEL_DIR at a copy already on this PC instead.
 */
export function downloadAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const testing = env['INSECTOIDS_E2E'] === '1' || Boolean(env['VITEST']);
  return !testing || env['INSECTOIDS_ALLOW_MODEL_DOWNLOAD'] === '1';
}

const sourceText = (m: EmbeddingModel): string => `huggingface.co/${m.repo} (revision ${m.revision.slice(0, 7)}, every file checked)`;

const offMessage = (m: EmbeddingModel, present: boolean): string =>
  present
    ? 'Off: the Brain is searched by words only. The model is already on this PC; switching on starts indexing.'
    : `Off: the Brain is searched by words only. Switching on downloads the ${mb(modelSize(m))} MB model once from Hugging Face; nothing about your Brain leaves this PC.`;

async function defaultLoadEmbedder(m: EmbeddingModel, dir: string, wasmDir?: string): Promise<QueryEmbedder> {
  // Loaded only now, so the app starts without the WebAssembly runtime.
  const { OnnxEmbedder } = await import('@insectoids/embeddings');
  return OnnxEmbedder.load(m, dir, wasmDir ? { wasmDir } : {});
}

export class MeaningSearch {
  readonly #o: MeaningSearchOptions;
  readonly #model: EmbeddingModel;
  #enabled = false;
  #state: State = 'off';
  #message = '';
  #progress = 0;
  #present = false;
  #embedder: QueryEmbedder | null = null;
  /** Bumped on every switch, so a slow download or load from an earlier switch never takes effect. */
  #generation = 0;
  #loop: Promise<void> | null = null;
  #wake: (() => void) | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  #changeTimer: NodeJS.Timeout | null = null;
  #counts = { indexed: 0, total: 0 };

  constructor(o: MeaningSearchOptions) {
    this.#o = o;
    this.#model = o.model ?? MODELS[DEFAULT_MODEL];
  }

  /** Restores the user's choice; starts (and downloads if needed) when it was on. Never throws. */
  async init(): Promise<void> {
    this.#enabled = this.#readEnabled();
    this.#present = await this.#isPresent();
    this.#refreshCounts();
    if (this.#enabled) this.#start();
    else this.#setOff();
  }

  view(): MeaningSearchView {
    return {
      state: this.#state,
      model: this.#model.id,
      sizeMb: mb(modelSize(this.#model)),
      source: sourceText(this.#model),
      progress: this.#progress,
      indexed: this.#counts.indexed,
      total: this.#counts.total,
      message: this.#message,
    };
  }

  /** The user switched it on or off. Returns once the choice is saved; downloading and indexing go on in the background. */
  async setEnabled(on: boolean): Promise<void> {
    this.#enabled = on;
    this.#writeEnabled(on);
    if (on) {
      this.#start();
    } else {
      await this.#stop();
      this.#present = await this.#isPresent();
      this.#setOff();
    }
  }

  /** A search's query vector, or null when meaning search isn't running. */
  async embedQuery(text: string): Promise<{ vector: Float32Array; model: string } | null> {
    const e = this.#embedder;
    if (!e || (this.#state !== 'indexing' && this.#state !== 'ready') || !text.trim()) return null;
    const [vector] = await this.#serial(() => e.embed([text], 'query'));
    return vector ? { vector, model: this.#model.id } : null;
  }

  async dispose(): Promise<void> {
    await this.#stop();
    if (this.#changeTimer) clearTimeout(this.#changeTimer);
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  #start(): void {
    const gen = ++this.#generation;
    void this.#bringUp(gen).catch((err: unknown) => {
      if (gen !== this.#generation) return;
      const why = err instanceof Error ? err.message : String(err);
      this.#o.log?.(`[meaning] ${why}`);
      this.#set('error', `Meaning search stopped: ${why} Word search still works. Switch it off and on to try again.`);
    });
  }

  async #bringUp(gen: number): Promise<void> {
    const m = this.#model;
    const dir = modelDir(this.#o.modelsDir, m);
    if (!(await this.#isPresent())) {
      // The real downloader only; a test seam (o.download) is a fake and never touches the network.
      if (!this.#o.download && !downloadAllowed()) {
        throw new Error("The meaning model isn't on this PC, and tests never download it (set INSECTOIDS_E2E_MODEL_DIR to a downloaded copy).");
      }
      this.#set('downloading', `Downloading the meaning model (${mb(modelSize(m))} MB) from Hugging Face…`, 0);
      const total = modelSize(m);
      const done = new Map<string, number>();
      await (this.#o.download ?? downloadModel)(m, {
        dir: this.#o.modelsDir,
        onProgress: (p) => {
          if (gen !== this.#generation) return;
          done.set(p.file, p.received);
          const got = [...done.values()].reduce((a, b) => a + b, 0);
          this.#progress = Math.min(1, got / total);
          this.#message = `Downloading the meaning model… ${Math.round(this.#progress * 100)}%`;
          this.#changed();
        },
      });
      if (gen !== this.#generation) return;
      if (!(await this.#isPresent())) throw new Error('The downloaded model did not pass its checks.');
    }
    this.#present = true;
    if (gen !== this.#generation) return;
    this.#set('indexing', 'Loading the meaning model…', 1);
    const embedder = await (this.#o.loadEmbedder ?? defaultLoadEmbedder)(m, dir, this.#o.wasmDir);
    if (gen !== this.#generation) {
      await embedder.dispose();
      return;
    }
    this.#embedder = embedder;
    this.#refreshCounts();
    this.#set('indexing', this.#indexingMessage());
    this.#loop = this.#indexLoop(gen);
  }

  async #stop(): Promise<void> {
    this.#generation++;
    this.#wake?.();
    await this.#loop?.catch(() => {});
    this.#loop = null;
    const e = this.#embedder;
    this.#embedder = null;
    if (e) await this.#serial(() => e.dispose()).catch(() => {});
  }

  async #indexLoop(gen: number): Promise<void> {
    const { brain } = this.#o;
    const model = this.#model.id;
    const yieldMs = this.#o.yieldMs ?? 5;
    const idleMs = this.#o.idleMs ?? 3000;
    while (gen === this.#generation) {
      const next = brain.pendingVectors(model, 1)[0];
      if (!next) {
        this.#refreshCounts();
        if (this.#state !== 'ready') this.#set('ready', this.#readyMessage());
        else this.#message = this.#readyMessage();
        await this.#sleep(idleMs);
        continue;
      }
      if (this.#state !== 'indexing') this.#set('indexing', this.#indexingMessage());
      const e = this.#embedder;
      if (!e) return;
      const [vector] = await this.#serial(() => e.embed([next.text], 'passage'));
      if (gen !== this.#generation) return;
      if (vector) brain.setVector(next.id, model, vector, next.contentHash);
      this.#refreshCounts();
      this.#message = this.#indexingMessage();
      this.#changed();
      await this.#sleep(yieldMs);
    }
  }

  // ---- helpers ---------------------------------------------------------------------------------

  /** One model run at a time: the WASM session is single-threaded. Queries queue between index steps. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => {});
    return run;
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.#wake = null;
        resolve();
      }, ms);
      this.#wake = () => {
        clearTimeout(t);
        this.#wake = null;
        resolve();
      };
    });
  }

  #refreshCounts(): void {
    this.#counts = this.#o.brain.vectorProgress(this.#model.id);
  }

  #indexingMessage(): string {
    return `Indexing: ${this.#counts.indexed} of ${this.#counts.total} records searchable by meaning so far. Search uses them already.`;
  }

  #readyMessage(): string {
    return `On: ${this.#counts.indexed} records searchable by meaning, on this PC.`;
  }

  #setOff(): void {
    this.#set(this.#present ? 'off' : 'needs-download', offMessage(this.#model, this.#present), 0);
  }

  #set(state: State, message: string, progress = this.#progress): void {
    this.#state = state;
    this.#message = message;
    this.#progress = progress;
    this.#changed(true);
  }

  /** The window re-reads at most every 500 ms while indexing; state changes go out at once. */
  #changed(now = false): void {
    if (now) {
      if (this.#changeTimer) clearTimeout(this.#changeTimer);
      this.#changeTimer = null;
      this.#o.onChange();
      return;
    }
    if (this.#changeTimer) return;
    this.#changeTimer = setTimeout(() => {
      this.#changeTimer = null;
      this.#o.onChange();
    }, 500);
  }

  async #isPresent(): Promise<boolean> {
    try {
      return await (this.#o.isPresent ?? isModelPresent)(this.#o.modelsDir, this.#model);
    } catch {
      return false;
    }
  }

  #readEnabled(): boolean {
    try {
      if (!existsSync(this.#o.settingsFile)) return false;
      const raw = JSON.parse(readFileSync(this.#o.settingsFile, 'utf8')) as { enabled?: unknown };
      return raw.enabled === true;
    } catch {
      return false;
    }
  }

  #writeEnabled(on: boolean): void {
    try {
      mkdirSync(dirname(this.#o.settingsFile), { recursive: true });
      const tmp = `${this.#o.settingsFile}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ enabled: on })}\n`);
      renameSync(tmp, this.#o.settingsFile);
    } catch (err) {
      this.#o.log?.(`[meaning] could not save the setting: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
