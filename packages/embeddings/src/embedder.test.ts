import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isModelPresent, modelDir } from './download';
import { OnnxEmbedder } from './embedder';
import { DEFAULT_MODEL, MODELS } from './models';
import { cosine, dot } from './vector';

// The real model lives in the user's app profile once downloaded (B1, with the user's consent). These tests
// run only where it's present, so CI and fresh machines skip them instead of downloading anything.
const MODELS_DIR = join(process.env['APPDATA'] ?? join(process.env['HOME'] ?? '.', '.config'), 'The Insectoids', 'models');
const m = MODELS[DEFAULT_MODEL];
const present = await isModelPresent(MODELS_DIR, m).catch(() => false);

describe.skipIf(!present)('the default embedding model (real, local, WASM)', () => {
  it('gives 384-d unit vectors that rank meaning, not just words', async () => {
    const e = await OnnxEmbedder.load(m, modelDir(MODELS_DIR, m));
    try {
      const [q] = await e.embed(['how are API keys kept away from agents'], 'query');
      const [good, bad] = await e.embed(['The vault encrypts secrets; insects use a broker and never see them.', 'The taskboard shows cards in columns.'], 'passage');
      expect(q!.length).toBe(384);
      expect(dot(q!, q!)).toBeCloseTo(1, 4);
      expect(cosine(q!, good!)).toBeGreaterThan(cosine(q!, bad!));
      // Batching by length must keep each text's vector.
      const texts = ['short', 'a much longer sentence about the hive and its brain', 'mid length text'];
      const together = await e.embed(texts, 'passage');
      for (const [i, t] of texts.entries()) {
        const [alone] = await e.embed([t], 'passage');
        expect(cosine(alone!, together[i]!)).toBeGreaterThan(0.99);
      }
    } finally {
      await e.dispose();
    }
  });
});
