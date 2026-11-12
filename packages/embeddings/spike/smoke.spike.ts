import { describe, expect, it } from 'vitest';
import { MODELS, OnnxEmbedder, cosine, modelDir } from '../src';
import { MODELS_DIR } from './paths';

describe.skipIf(process.env['SPIKE'] !== '1')('models run in Node (WASM)', () => {
  for (const m of Object.values(MODELS)) {
    it(m.id, async () => {
      const t0 = performance.now();
      const e = await OnnxEmbedder.load(m, modelDir(MODELS_DIR, m));
      const load = performance.now() - t0;
      const [q] = await e.embed(['how are API keys kept away from agents'], 'query');
      const [good, bad] = await e.embed(['The vault encrypts secrets; insects use a broker and never see the key.', 'The taskboard shows cards in columns by status.'], 'passage');
      console.log(m.id, 'load', load.toFixed(0), 'ms; sim good', cosine(q!, good!).toFixed(3), 'bad', cosine(q!, bad!).toFixed(3), 'dim', q!.length);
      expect(cosine(q!, good!)).toBeGreaterThan(cosine(q!, bad!));
      await e.dispose();
    });
  }
});
