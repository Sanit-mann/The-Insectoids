import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDoorPaths } from './doors';

describe('resolveDoorPaths', () => {
  const base = { resourcesPath: '/app/resources', execPath: '/app/insectoids' };

  it('dev: the workspace packages\' dist bundles, run on the app executable as Node', () => {
    const repo = join('/repo');
    const d = resolveDoorPaths({ ...base, mainDir: join(repo, 'apps', 'desktop', 'out', 'main'), isPackaged: false });
    expect(d).toEqual({
      runtime: { command: '/app/insectoids', env: { ELECTRON_RUN_AS_NODE: '1' } },
      guardHook: join(repo, 'packages', 'reflexes', 'dist', 'guard-hook.mjs'),
      brainMcp: join(repo, 'packages', 'brain-mcp', 'dist', 'brain-mcp.mjs'),
      brainCli: join(repo, 'packages', 'brain-cli', 'dist', 'brain.mjs'),
      hiveTools: join(repo, 'packages', 'hive-tools-mcp', 'dist', 'hive-tools-mcp.mjs'),
      servicesMcp: join(repo, 'packages', 'services-mcp', 'dist', 'services-mcp.mjs'),
    });
  });

  it('packaged: resources/doors', () => {
    const d = resolveDoorPaths({ ...base, mainDir: '/x', isPackaged: true });
    expect(d.brainMcp).toBe(join('/app/resources', 'doors', 'brain-mcp.mjs'));
  });
});
