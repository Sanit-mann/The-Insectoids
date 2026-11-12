import type { ProviderView } from '@insectoids/shared';
import { describe, expect, it } from 'vitest';
import { readyProviders } from './ready-providers';

const view = (o: Partial<ProviderView>): ProviderView => ({
  id: 'p',
  label: 'P',
  preset: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  secretRef: null,
  models: { strongest: 'a', standard: 'b', light: 'c' },
  enabled: true,
  status: 'ready',
  message: '',
  local: true,
  lastTestedAt: 1,
  knownModels: [],
  ...o,
});

describe('providers the hive may use', () => {
  it('keeps only enabled, ready, tested providers, in order, without key handles', () => {
    const out = readyProviders([
      view({ id: 'ollama' }),
      view({ id: 'off', enabled: false }),
      view({ id: 'nokey', status: 'needs-key' }),
      view({ id: 'untested', lastTestedAt: null }),
      view({ id: 'openrouter', local: false, secretRef: 'sec_abcdefgh12' }),
    ]);
    expect(out.map((p) => p.id)).toEqual(['ollama', 'openrouter']);
    expect(JSON.stringify(out)).not.toContain('sec_');
    expect(out[1]).toEqual({ id: 'openrouter', label: 'P', local: false, models: { strongest: 'a', standard: 'b', light: 'c' } });
  });
});
