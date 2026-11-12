import { describe, expect, it } from 'vitest';
import { MODELS, downloadModel, isModelPresent, modelDir, modelSize } from '../src';
import { MODELS_DIR } from './paths';

describe.skipIf(process.env['SPIKE'] !== '1')('download the approved models', () => {
  for (const m of Object.values(MODELS)) {
    it(`${m.id} (${(modelSize(m) / 1e6).toFixed(1)} MB)`, async () => {
      let last = 0;
      const dir = await downloadModel(m, {
        dir: MODELS_DIR,
        onProgress: (p) => {
          const pct = Math.floor((p.received / p.total) * 10);
          if (pct !== last) { last = pct; process.stdout.write(`${m.id} ${p.file} ${pct * 10}%\n`); }
        },
      });
      expect(dir).toBe(modelDir(MODELS_DIR, m));
      expect(await isModelPresent(MODELS_DIR, m)).toBe(true);
    });
  }
});
