import { join } from 'node:path';
import type { DoorPaths } from '../brain-host/messages';

/**
 * Where the bundled door scripts live. In development they are the workspace packages' build output
 * (`pnpm build:doors`). Door processes run on the app's own executable as Node (ELECTRON_RUN_AS_NODE),
 * so users need no separate Node install.
 *
 * TODO(Phase 3, packaging): ship the bundles in resources/doors and resolve them from process.resourcesPath.
 */
export function resolveDoorPaths(o: { mainDir: string; isPackaged: boolean; resourcesPath: string; execPath: string }): DoorPaths {
  const runtime = { command: o.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  if (o.isPackaged) {
    const dir = join(o.resourcesPath, 'doors');
    // TODO(Phase 3, packaging): ship onnxruntime-web's ort-wasm-simd-threaded.{wasm,mjs} in resources/ort.
    return { runtime, guardHook: join(dir, 'guard-hook.mjs'), brainMcp: join(dir, 'brain-mcp.mjs'), brainCli: join(dir, 'brain.mjs'), hiveTools: join(dir, 'hive-tools-mcp.mjs'), servicesMcp: join(dir, 'services-mcp.mjs'), ortWasmDir: join(o.resourcesPath, 'ort') };
  }
  // mainDir is apps/desktop/out/main; the repo root is four levels up.
  const packages = join(o.mainDir, '..', '..', '..', '..', 'packages');
  return {
    runtime,
    guardHook: join(packages, 'reflexes', 'dist', 'guard-hook.mjs'),
    brainMcp: join(packages, 'brain-mcp', 'dist', 'brain-mcp.mjs'),
    brainCli: join(packages, 'brain-cli', 'dist', 'brain.mjs'),
    hiveTools: join(packages, 'hive-tools-mcp', 'dist', 'hive-tools-mcp.mjs'),
    servicesMcp: join(packages, 'services-mcp', 'dist', 'services-mcp.mjs'),
    // Dev: the embeddings package's own onnxruntime-web (pnpm links it there); the host bundle can't resolve it.
    ortWasmDir: join(packages, 'embeddings', 'node_modules', 'onnxruntime-web', 'dist'),
  };
}

/**
 * The agents/skills library the hive builds prompts from. Dev: the repo's `library/` folder.
 * TODO(Phase 3, packaging): ship it in resources/library.
 */
export function resolveLibraryDir(o: { mainDir: string; isPackaged: boolean; resourcesPath: string }): string {
  return o.isPackaged ? join(o.resourcesPath, 'library') : join(o.mainDir, '..', '..', '..', '..', 'library');
}
