import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EmbeddingModel, ModelFile } from './models';

/** Hosts a model download may touch: the Hub itself and the CDNs it redirects LFS files to. */
const ALLOWED_HOSTS = [/^huggingface\.co$/, /^cdn-lfs(-[a-z0-9]+)?\.hf\.co$/, /^cdn-lfs(-[a-z0-9]+)?\.huggingface\.co$/, /^cas-bridge\.xethub\.hf\.co$/, /(^|\.)hf\.co$/];

export interface DownloadProgress {
  file: string;
  received: number;
  total: number;
}

export interface DownloadOptions {
  /** Folder for this model: <dir>/<repo-name>/<revision>/ is created under it. */
  dir: string;
  onProgress?: (p: DownloadProgress) => void;
  /** Per-file timeout without progress, in ms (default 60 s). */
  stallTimeoutMs?: number;
  fetch?: typeof fetch;
}

export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloadError';
  }
}

/** Where a model's files live: <dir>/<repo name>/<revision>/. */
export function modelDir(dir: string, m: EmbeddingModel): string {
  return join(dir, m.repo.split('/')[1]!, m.revision);
}

function hostAllowed(url: URL): boolean {
  return url.protocol === 'https:' && ALLOWED_HOSTS.some((re) => re.test(url.hostname));
}

async function digest(path: string, f: ModelFile): Promise<boolean> {
  if (!existsSync(path) || statSync(path).size !== f.size) return false;
  const h = f.sha256 ? createHash('sha256') : createHash('sha1');
  if (!f.sha256) h.update(`blob ${f.size}\0`);
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return h.digest('hex') === (f.sha256 ?? f.gitSha1);
}

/** True when every file of the model is on disk and matches its checksum. */
export async function isModelPresent(dir: string, m: EmbeddingModel): Promise<boolean> {
  const base = modelDir(dir, m);
  for (const f of m.files) if (!(await digest(join(base, f.path), f))) return false;
  return true;
}

async function fetchFollowing(url: URL, fetchFn: typeof fetch, signal: AbortSignal, from: number): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    if (!hostAllowed(current)) throw new DownloadError(`Refused to download from ${current.host}: only Hugging Face is allowed.`);
    const res = await fetchFn(current, { redirect: 'manual', signal, headers: from > 0 ? { range: `bytes=${from}-` } : {} });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new DownloadError('Redirect without a location.');
      current = new URL(loc, current);
      continue;
    }
    return res;
  }
  throw new DownloadError('Too many redirects.');
}

/**
 * Downloads a model's files, only when called (the user agreed first). Each file goes to `<name>.part`,
 * is resumed if a partial file exists, is checked against its pinned checksum, and only then renamed into
 * place. A file that fails its check is deleted. Files already present and valid are skipped.
 */
export async function downloadModel(m: EmbeddingModel, o: DownloadOptions): Promise<string> {
  const base = modelDir(o.dir, m);
  const fetchFn = o.fetch ?? fetch;
  const stall = o.stallTimeoutMs ?? 60_000;
  for (const f of m.files) {
    const target = join(base, f.path);
    if (await digest(target, f)) continue;
    mkdirSync(dirname(target), { recursive: true });
    const part = `${target}.part`;
    let from = existsSync(part) ? statSync(part).size : 0;
    if (from >= f.size) {
      rmSync(part, { force: true });
      from = 0;
    }
    const url = new URL(`https://huggingface.co/${m.repo}/resolve/${m.revision}/${f.path}`);
    const ac = new AbortController();
    let timer = setTimeout(() => ac.abort(), stall);
    try {
      const res = await fetchFollowing(url, fetchFn, ac.signal, from);
      if (res.status === 200 && from > 0) from = 0; // server ignored the range: start over
      else if (res.status !== 200 && res.status !== 206) throw new DownloadError(`${f.path}: HTTP ${res.status}`);
      if (!res.body) throw new DownloadError(`${f.path}: empty response`);
      const fh = await open(part, from > 0 ? 'a' : 'w');
      let received = from;
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          clearTimeout(timer);
          timer = setTimeout(() => ac.abort(), stall);
          received += chunk.byteLength;
          if (received > f.size) throw new DownloadError(`${f.path}: larger than expected`);
          await fh.write(chunk);
          o.onProgress?.({ file: f.path, received, total: f.size });
        }
      } finally {
        await fh.close();
      }
    } finally {
      clearTimeout(timer);
    }
    if (!(await digest(part, f))) {
      rmSync(part, { force: true });
      throw new DownloadError(`${f.path}: checksum mismatch; the file was deleted.`);
    }
    renameSync(part, target);
  }
  return base;
}
