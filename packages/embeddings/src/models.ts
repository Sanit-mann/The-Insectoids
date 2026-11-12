/**
 * The embedding models the Brain may use for meaning search (Memory 01-E11; Phase 2 B1).
 * Each is pinned to one Hugging Face revision, and every file to its size and checksum:
 * LFS files by SHA-256 (from the Hub's LFS pointer), small files by their git blob SHA-1 (the Hub's blob id).
 */
export interface ModelFile {
  /** Path inside the repo, e.g. "onnx/model_quantized.onnx". */
  path: string;
  size: number;
  sha256?: string;
  /** Git blob SHA-1 (sha1("blob <size>\0" + bytes)), for files the Hub doesn't store in LFS. */
  gitSha1?: string;
}

export interface EmbeddingModel {
  id: 'bge-small-en-v1.5' | 'all-MiniLM-L6-v2';
  repo: string;
  revision: string;
  license: string;
  files: ModelFile[];
  onnxFile: string;
  dimensions: number;
  /** Tokens per text including special tokens; longer texts are cut. */
  maxTokens: number;
  pooling: 'cls' | 'mean';
  /** Prepended to queries only (bge's retrieval instruction). */
  queryPrefix: string;
}

export const MODELS: Record<EmbeddingModel['id'], EmbeddingModel> = {
  'bge-small-en-v1.5': {
    id: 'bge-small-en-v1.5',
    repo: 'Xenova/bge-small-en-v1.5',
    revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
    license: 'MIT (BAAI/bge-small-en-v1.5)',
    files: [
      { path: 'onnx/model_quantized.onnx', size: 34_014_426, sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4' },
      { path: 'tokenizer.json', size: 711_396, gitSha1: '688882a79f44442ddc1f60d70334a7ff5df0fb47' },
      { path: 'tokenizer_config.json', size: 366, gitSha1: '37fca74771bc76a8e01178ce3a6055a0995f8093' },
      { path: 'config.json', size: 683, gitSha1: '0c4d86248983ce46dfc09a9091b6f56bb0224550' },
    ],
    onnxFile: 'onnx/model_quantized.onnx',
    dimensions: 384,
    maxTokens: 512,
    pooling: 'cls',
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
  },
  'all-MiniLM-L6-v2': {
    id: 'all-MiniLM-L6-v2',
    repo: 'Xenova/all-MiniLM-L6-v2',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    license: 'Apache-2.0',
    files: [
      { path: 'onnx/model_quantized.onnx', size: 22_972_370, sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1' },
      { path: 'tokenizer.json', size: 711_661, gitSha1: 'c17ed520ed8438736732a54957a69306b8822215' },
      { path: 'tokenizer_config.json', size: 366, gitSha1: '37fca74771bc76a8e01178ce3a6055a0995f8093' },
      { path: 'config.json', size: 650, gitSha1: '72147e4ff4426ebedbfa2146c4a0999def51a313' },
    ],
    onnxFile: 'onnx/model_quantized.onnx',
    dimensions: 384,
    maxTokens: 256,
    pooling: 'mean',
    queryPrefix: '',
  },
};

/** Total download size of a model, in bytes. */
export const modelSize = (m: EmbeddingModel): number => m.files.reduce((n, f) => n + f.size, 0);

/**
 * The Brain's default (B1 spike, 2026-11-12, packages/embeddings/spike/results.md): on 168 passages of this
 * repo and 50 queries, hybrid "any word" FTS5 + MiniLM scored best overall (recall@5 0.663, MRR@10 0.687,
 * keyword queries 1.0) and ran ~3× faster with ~15× less memory than bge-small (80 vs 231 ms per passage,
 * +37 MB vs +560 MB). bge-small stays listed as an option but is not downloaded by default.
 */
export const DEFAULT_MODEL: EmbeddingModel['id'] = 'all-MiniLM-L6-v2';
