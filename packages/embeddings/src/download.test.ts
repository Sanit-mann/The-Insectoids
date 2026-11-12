import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DownloadError, downloadModel, isModelPresent, modelDir } from './download';
import type { EmbeddingModel } from './models';

const bin = Buffer.from('fake-onnx-weights-'.repeat(100));
const json = Buffer.from('{"tokenizer":true}');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const gitSha1 = (b: Buffer) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

const model: EmbeddingModel = {
  id: 'all-MiniLM-L6-v2',
  repo: 'Xenova/test-model',
  revision: 'abc123',
  license: 'test',
  files: [
    { path: 'onnx/model_quantized.onnx', size: bin.length, sha256: sha256(bin) },
    { path: 'tokenizer.json', size: json.length, gitSha1: gitSha1(json) },
  ],
  onnxFile: 'onnx/model_quantized.onnx',
  dimensions: 4,
  maxTokens: 8,
  pooling: 'mean',
  queryPrefix: '',
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'insectoids-models-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface FakeHubOptions {
  body?: (path: string) => Buffer;
  redirectTo?: string;
  calls?: string[];
}

/** A fake Hub: /resolve/ redirects LFS files to the CDN, which serves bytes (and honours Range). */
function fakeHub(o: FakeHubOptions = {}): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const range = new Headers(init?.headers).get('range');
    o.calls?.push(`${url.host}${url.pathname} ${range ?? ''}`.trim());
    const path = url.pathname.split('/abc123/')[1] ?? url.pathname.replace(/^\/cdn\//, '');
    if (url.host === 'huggingface.co' && path.endsWith('.onnx')) {
      return new Response(null, { status: 302, headers: { location: o.redirectTo ?? `https://cdn-lfs.hf.co/cdn/${path}` } });
    }
    const full = (o.body ?? ((p: string) => (p.endsWith('.onnx') ? bin : json)))(path);
    if (range) {
      const from = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
      return new Response(full.subarray(from), { status: 206 });
    }
    return new Response(full, { status: 200 });
  }) as typeof fetch;
}

describe('model download (only on request, pinned and verified)', () => {
  it('downloads every file, verifies its checksum, and skips files already present', async () => {
    const calls: string[] = [];
    const base = await downloadModel(model, { dir, fetch: fakeHub({ calls }) });
    expect(base).toBe(modelDir(dir, model));
    expect(readFileSync(join(base, 'onnx', 'model_quantized.onnx')).equals(bin)).toBe(true);
    expect(await isModelPresent(dir, model)).toBe(true);
    const before = calls.length;
    await downloadModel(model, { dir, fetch: fakeHub({ calls }) });
    expect(calls.length).toBe(before);
  });

  it('a checksum mismatch deletes the file and fails', async () => {
    const tampered = Buffer.alloc(bin.length, 0x41);
    await expect(downloadModel(model, { dir, fetch: fakeHub({ body: (p) => (p.endsWith('.onnx') ? tampered : json) }) })).rejects.toThrow(/checksum/);
    expect(existsSync(join(modelDir(dir, model), 'onnx', 'model_quantized.onnx'))).toBe(false);
    expect(existsSync(join(modelDir(dir, model), 'onnx', 'model_quantized.onnx.part'))).toBe(false);
  });

  it('refuses a file larger than pinned', async () => {
    const big = Buffer.alloc(bin.length + 10, 0x41);
    await expect(downloadModel(model, { dir, fetch: fakeHub({ body: (p) => (p.endsWith('.onnx') ? big : json) }) })).rejects.toThrow(/larger/);
  });

  it('refuses redirects to hosts other than Hugging Face, and plain http', async () => {
    await expect(downloadModel(model, { dir, fetch: fakeHub({ redirectTo: 'https://evil.example.com/x.onnx' }) })).rejects.toBeInstanceOf(DownloadError);
    await expect(downloadModel(model, { dir, fetch: fakeHub({ redirectTo: 'http://cdn-lfs.hf.co/x.onnx' }) })).rejects.toThrow(/only Hugging Face/);
  });

  it('resumes a partial download with a Range request', async () => {
    const target = join(modelDir(dir, model), 'onnx', 'model_quantized.onnx');
    mkdirSync(join(modelDir(dir, model), 'onnx'), { recursive: true });
    writeFileSync(`${target}.part`, bin.subarray(0, 500));
    const calls: string[] = [];
    await downloadModel(model, { dir, fetch: fakeHub({ calls }) });
    expect(calls.some((c) => c.includes('bytes=500-'))).toBe(true);
    expect(readFileSync(target).equals(bin)).toBe(true);
  });
});
