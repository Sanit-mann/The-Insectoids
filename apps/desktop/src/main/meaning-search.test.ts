import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Brain, openBrain } from '@insectoids/brain';
import { MODELS } from '@insectoids/embeddings/models';
import { MeaningSearchSchema } from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MeaningSearch, type QueryEmbedder, downloadAllowed, meaningSearchOffView } from '../brain-host/meaning-search';

const user = { type: 'user' } as const;
const model = MODELS['all-MiniLM-L6-v2'];

/** Fake embedder: texts mentioning "key"/"secret"/"password" point one way, everything else another. */
class FakeEmbedder implements QueryEmbedder {
  readonly modelId = model.id;
  calls: Array<{ texts: string[]; kind: string }> = [];
  disposed = false;
  async embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
    this.calls.push({ texts, kind });
    return texts.map((t) => (/key|secret|password/i.test(t) ? Float32Array.from([1, 0, 0]) : Float32Array.from([0, 0, 1])));
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

let dir: string;
let brain: Brain;
let ms: MeaningSearch | null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'insectoids-meaning-'));
  brain = openBrain(':memory:');
  ms = null;
});
afterEach(async () => {
  await ms?.dispose();
  brain.close();
  rmSync(dir, { recursive: true, force: true });
});

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function make(o: { present?: boolean; embedder?: FakeEmbedder; downloads?: string[] } = {}) {
  let present = o.present ?? true;
  const embedder = o.embedder ?? new FakeEmbedder();
  const changes: string[] = [];
  const service = new MeaningSearch({
    brain,
    settingsFile: join(dir, 'meaning-search.json'),
    modelsDir: join(dir, 'models'),
    onChange: () => changes.push('changed'),
    isPresent: async () => present,
    download: async (_m, opts) => {
      o.downloads?.push('download');
      opts.onProgress?.({ file: model.onnxFile, received: 5, total: 10 });
      present = true;
      return '';
    },
    loadEmbedder: async () => embedder,
    yieldMs: 0,
    idleMs: 20,
  });
  ms = service;
  return { service, embedder, changes };
}

describe('meaning search in the Brain host (Phase 2 B1)', () => {
  it('is off on a fresh profile, even when the model is already on this PC (the user decides)', async () => {
    const { service, embedder } = make({ present: true });
    await service.init();
    const v = service.view();
    expect(MeaningSearchSchema.parse(v)).toMatchObject({ state: 'off', model: 'all-MiniLM-L6-v2' });
    expect(v.message).toMatch(/already on this PC/);
    expect(embedder.calls).toEqual([]);
    expect(await service.embedQuery('anything')).toBeNull();
  });

  it('off without the model on this PC is "needs-download"; the view names the size and source first', async () => {
    const { service } = make({ present: false });
    await service.init();
    expect(service.view().state).toBe('needs-download');
    expect(meaningSearchOffView(undefined, true).state).toBe('off');
    const v = meaningSearchOffView();
    expect(v.state).toBe('needs-download');
    expect(v.sizeMb).toBeGreaterThan(20);
    expect(v.sizeMb).toBeLessThan(30);
    expect(v.source).toMatch(/huggingface\.co\/Xenova\/all-MiniLM-L6-v2/);
    expect(v.message).toMatch(/downloads the .* MB model once/);
  });

  it('switching on downloads a missing model, then indexes every record, newest first, one at a time', async () => {
    const downloads: string[] = [];
    brain.write({ kind: 'fact', shelf: 'site', title: 'Vault', body: 'API keys are encrypted.' }, user);
    brain.write({ kind: 'fact', shelf: 'site', title: 'Theme', body: 'Dark and light.' }, user);
    const { service, embedder } = make({ present: false, downloads });
    await service.init();
    await service.setEnabled(true);
    await until(() => service.view().state === 'ready');
    expect(downloads).toEqual(['download']);
    expect(service.view()).toMatchObject({ indexed: 2, total: 2 });
    expect(embedder.calls.every((c) => c.texts.length === 1 && c.kind === 'passage')).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'meaning-search.json'), 'utf8'))).toEqual({ enabled: true });
  });

  it('queries get a vector while on; search then finds by meaning', async () => {
    const vault = brain.write({ kind: 'fact', shelf: 'site', title: 'Vault', body: 'API keys are encrypted.' }, user).id;
    const { service } = make();
    await service.init();
    await service.setEnabled(true);
    await until(() => service.view().state === 'ready');
    const q = await service.embedQuery('how are passwords protected');
    expect(q?.model).toBe('all-MiniLM-L6-v2');
    const hits = brain.search('how are passwords protected', { shelf: 'site', queryVector: q!.vector, vectorModel: q!.model });
    expect(hits.map((h) => [h.id, h.match])).toEqual([[vault, 'meaning']]);
  });

  it('new and changed records are picked up in the background', async () => {
    const { service } = make();
    await service.init();
    await service.setEnabled(true);
    await until(() => service.view().state === 'ready');
    const id = brain.write({ kind: 'fact', shelf: 'site', title: 'Later', body: 'secret note' }, user).id;
    await until(() => service.view().indexed === 1);
    brain.update(id, { body: 'secret note, edited' }, user);
    await until(() => brain.vectorProgress(model.id).indexed === 1 && brain.pendingVectors(model.id).length === 0);
  });

  it('switching off unloads the model, keeps the vectors, and is remembered', async () => {
    brain.write({ kind: 'fact', shelf: 'site', title: 'Vault', body: 'keys' }, user);
    const { service, embedder } = make();
    await service.init();
    await service.setEnabled(true);
    await until(() => service.view().state === 'ready');
    await service.setEnabled(false);
    expect(service.view().state).toBe('off');
    expect(embedder.disposed).toBe(true);
    expect(await service.embedQuery('keys')).toBeNull();
    expect(brain.vectorProgress(model.id).indexed).toBe(1);
    // A restart remembers "off".
    const again = make();
    await again.service.init();
    expect(again.service.view().state).toBe('off');
  });

  it('a restart with meaning search on brings it back up by itself', async () => {
    const first = make();
    await first.service.init();
    await first.service.setEnabled(true);
    await until(() => first.service.view().state === 'ready');
    await first.service.dispose();
    const second = make();
    await second.service.init();
    await until(() => second.service.view().state === 'ready');
  });

  it('a model that fails to load gives a plain error; word search keeps working', async () => {
    const service = new MeaningSearch({
      brain,
      settingsFile: join(dir, 'm.json'),
      modelsDir: join(dir, 'models'),
      onChange: () => {},
      isPresent: async () => true,
      loadEmbedder: async () => Promise.reject(new Error('WebAssembly could not start.')),
    });
    ms = service;
    await service.init();
    await service.setEnabled(true);
    await until(() => service.view().state === 'error');
    expect(service.view().message).toMatch(/WebAssembly could not start\..*Word search still works/);
    expect(await service.embedQuery('x')).toBeNull();
  });

  it('tests never download: without the model, switching on ends in a plain error and nothing is fetched', async () => {
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      throw new Error('no network in tests');
    }) as typeof fetch;
    try {
      // No download seam: the real downloader would run, and the guard must stop it first.
      const service = new MeaningSearch({
        brain,
        settingsFile: join(dir, 'g.json'),
        modelsDir: join(dir, 'empty-models'),
        onChange: () => {},
        isPresent: async () => false,
        loadEmbedder: async () => new FakeEmbedder(),
      });
      ms = service;
      await service.init();
      expect(service.view().state).toBe('needs-download');
      await service.setEnabled(true);
      await until(() => service.view().state === 'error');
      expect(service.view().message).toMatch(/tests never download/);
      expect(fetched).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('the download guard: refused under e2e or vitest unless explicitly allowed; allowed in the real app', () => {
    expect(downloadAllowed({ INSECTOIDS_E2E: '1' })).toBe(false);
    expect(downloadAllowed({ VITEST: 'true' })).toBe(false);
    expect(downloadAllowed({ INSECTOIDS_E2E: '1', INSECTOIDS_ALLOW_MODEL_DOWNLOAD: '1' })).toBe(true);
    expect(downloadAllowed({})).toBe(true);
  });
});
