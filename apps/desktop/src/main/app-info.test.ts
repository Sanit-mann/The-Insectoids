import { describe, expect, it } from 'vitest';
import { buildAppInfo } from './app-info';

describe('buildAppInfo', () => {
  it('returns a validated payload', () => {
    expect(buildAppInfo({ name: 'The Insectoids', version: '0.0.1', platform: 'win32', electron: '45.2.3' })).toEqual({
      name: 'The Insectoids',
      version: '0.0.1',
      platform: 'win32',
      electron: '45.2.3',
    });
  });

  it('refuses an unsupported platform', () => {
    expect(() => buildAppInfo({ name: 'x', version: '1', platform: 'aix', electron: '1' })).toThrow();
  });
});
