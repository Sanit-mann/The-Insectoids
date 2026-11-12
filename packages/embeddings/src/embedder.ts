import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Tokenizer } from '@huggingface/tokenizers';
import * as ort from 'onnxruntime-web';
import type { EmbeddingModel } from './models';
import { normalize } from './vector';

/** Something that turns texts into unit vectors. The real one runs an ONNX model; tests use a fake. */
export interface TextEmbedder {
  readonly dimensions: number;
  readonly modelId: string;
  embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]>;
  dispose(): Promise<void>;
}

const require_ = createRequire(import.meta.url);

/**
 * Folder holding onnxruntime-web's WASM files. Only the plain single-threaded SIMD build is used: no
 * worker threads, no network, so it runs the same in Node, Electron's main and a utilityProcess.
 */
export function ortWasmDir(): string {
  return dirname(require_.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'));
}

let ortConfigured = false;
function configureOrt(wasmDir: string): void {
  if (ortConfigured) return;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  // Explicit files, so nothing is fetched from a CDN and no other (threaded/JSEP) build is tried.
  ort.env.wasm.wasmPaths = {
    wasm: pathToFileURL(join(wasmDir, 'ort-wasm-simd-threaded.wasm')).href,
    mjs: pathToFileURL(join(wasmDir, 'ort-wasm-simd-threaded.mjs')).href,
  };
  ort.env.logLevel = 'error';
  ortConfigured = true;
}

interface TokenizedBatch {
  ids: BigInt64Array;
  mask: BigInt64Array;
  types: BigInt64Array;
  maskNum: Uint8Array;
  length: number;
}

/** An ONNX sentence-embedding model (bge / MiniLM family) on the WASM backend. */
export class OnnxEmbedder implements TextEmbedder {
  readonly dimensions: number;
  readonly modelId: string;
  readonly #m: EmbeddingModel;
  readonly #session: ort.InferenceSession;
  readonly #tok: Tokenizer;
  readonly #inputs: Set<string>;
  readonly #batch: number;

  private constructor(m: EmbeddingModel, session: ort.InferenceSession, tok: Tokenizer, batch: number) {
    this.#m = m;
    this.#session = session;
    this.#tok = tok;
    this.#inputs = new Set(session.inputNames);
    this.#batch = batch;
    this.dimensions = m.dimensions;
    this.modelId = m.id;
  }

  /** Loads a downloaded model from `dir` (its files already verified). */
  static async load(m: EmbeddingModel, dir: string, o: { batchSize?: number; wasmDir?: string } = {}): Promise<OnnxEmbedder> {
    configureOrt(o.wasmDir ?? ortWasmDir());
    const tokJson = JSON.parse(readFileSync(join(dir, 'tokenizer.json'), 'utf8')) as object;
    const tokCfg = JSON.parse(readFileSync(join(dir, 'tokenizer_config.json'), 'utf8')) as object;
    const tok = new Tokenizer(tokJson, tokCfg);
    const bytes = readFileSync(join(dir, m.onnxFile));
    const session = await ort.InferenceSession.create(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    // Default batch size 1: the quantized models scale activations per batch (dynamic int8), so a text's
    // vector shifts slightly with whatever shares its batch (cosine ~0.97 seen in the B1 spike). One text
    // per run makes every vector depend only on its own text, which duplicate checks and stable ranking need.
    return new OnnxEmbedder(m, session, tok, o.batchSize ?? 1);
  }

  #tokenize(texts: string[]): TokenizedBatch {
    const max = this.#m.maxTokens;
    const encoded = texts.map((t) => {
      const ids = this.#tok.encode(t).ids;
      // Cut long texts but keep the closing special token ([SEP]) the model expects.
      return ids.length > max ? [...ids.slice(0, max - 1), ids[ids.length - 1]!] : ids;
    });
    const length = Math.max(...encoded.map((e) => e.length));
    const n = texts.length * length;
    const ids = new BigInt64Array(n);
    const mask = new BigInt64Array(n);
    const types = new BigInt64Array(n);
    const maskNum = new Uint8Array(n);
    encoded.forEach((e, r) => {
      e.forEach((id, c) => {
        ids[r * length + c] = BigInt(id);
        mask[r * length + c] = 1n;
        maskNum[r * length + c] = 1;
      });
    });
    return { ids, mask, types, maskNum, length };
  }

  async #run(texts: string[]): Promise<Float32Array[]> {
    const b = this.#tokenize(texts);
    const dims = [texts.length, b.length];
    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor('int64', b.ids, dims),
      attention_mask: new ort.Tensor('int64', b.mask, dims),
    };
    if (this.#inputs.has('token_type_ids')) feeds['token_type_ids'] = new ort.Tensor('int64', b.types, dims);
    const out = await this.#session.run(feeds);
    const hidden = out[this.#session.outputNames[0]!]!;
    const data = hidden.data as Float32Array;
    const [, seq, dim] = hidden.dims as [number, number, number];
    const vectors: Float32Array[] = [];
    for (let r = 0; r < texts.length; r++) {
      const v = new Float32Array(dim);
      if (this.#m.pooling === 'cls') {
        v.set(data.subarray(r * seq * dim, r * seq * dim + dim));
      } else {
        let count = 0;
        for (let t = 0; t < seq; t++) {
          if (!b.maskNum[r * b.length + t]) continue;
          count++;
          const off = (r * seq + t) * dim;
          for (let d = 0; d < dim; d++) v[d]! += data[off + d]!;
        }
        for (let d = 0; d < dim; d++) v[d]! /= count || 1;
      }
      vectors.push(normalize(v));
    }
    for (const t of Object.values(out)) t.dispose?.();
    return vectors;
  }

  async embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
    const prepared = kind === 'query' && this.#m.queryPrefix ? texts.map((t) => this.#m.queryPrefix + t) : texts;
    // Batch texts of similar length together: every text in a batch is padded to the longest, and
    // attention cost grows with the square of that length, so mixing short and long wastes most of it.
    const order = prepared.map((t, i) => ({ t, i })).sort((a, b) => a.t.length - b.t.length);
    const out = new Array<Float32Array>(prepared.length);
    for (let s = 0; s < order.length; s += this.#batch) {
      const slice = order.slice(s, s + this.#batch);
      const vecs = await this.#run(slice.map((x) => x.t));
      slice.forEach((x, j) => (out[x.i] = vecs[j]!));
    }
    return out;
  }

  async dispose(): Promise<void> {
    await this.#session.release();
  }
}
