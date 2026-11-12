import { describe, expect, it } from 'vitest';
import { isRpcMessage, isStartMessage } from '../brain-host/messages';
import { resolveLibraryDir } from './doors';

describe('host messages (main <-> Brain host)', () => {
  it('accepts only well-formed start and rpc messages', () => {
    const doors = { runtime: { command: 'x', env: {} }, guardHook: 'g', brainMcp: 'm', brainCli: 'c', hiveTools: 'h', servicesMcp: 's' };
    const hive = { userDataDir: '/u', libraryDir: '/l', engine: 'fake' };
    expect(isStartMessage({ type: 'start', dbPath: 'a', endpoint: 'b', masterToken: 'c', doors, hive })).toBe(true);
    expect(isStartMessage({ type: 'start', dbPath: 'a', endpoint: 'b', masterToken: 'c', doors })).toBe(false);
    expect(isStartMessage(null)).toBe(false);
    expect(isRpcMessage({ type: 'rpc', id: 1, method: 'snapshot' })).toBe(true);
    expect(isRpcMessage({ type: 'rpc', id: '1', method: 'snapshot' })).toBe(false);
    expect(isRpcMessage({ type: 'rpc', id: 1 })).toBe(false);
  });

  it('finds the library in dev and in a packaged app', () => {
    const slashes = (p: string) => p.split('\\').join('/');
    expect(slashes(resolveLibraryDir({ mainDir: '/r/apps/desktop/out/main', isPackaged: false, resourcesPath: '/res' }))).toMatch(/\/r\/library$/);
    expect(slashes(resolveLibraryDir({ mainDir: '/x', isPackaged: true, resourcesPath: '/res' }))).toMatch(/\/res\/library$/);
  });
});
