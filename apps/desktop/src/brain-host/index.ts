/**
 * The Brain host: an Electron utilityProcess and the ONLY process that opens brain.db (single writer,
 * Memory 01-D14, Tech stack 09). It runs the Brain service that every door (MCP, `brain` CLI, and later
 * the local HTTP API) talks to.
 *
 * Decision (Phase 1, Step 7): this process is the **hive host**. In Step 8 the Hive runtime moves in here
 * too, sharing this one Brain instance, so the database keeps exactly one writer. The main process never
 * opens brain.db; it reaches the Brain through the service with the master token like any other client.
 */
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Brain, openBrain } from '@insectoids/brain';
import { writeBrainShims } from '@insectoids/brain-cli/shims';
import { type BrainService, startBrainService } from '@insectoids/brain-service';
import { type DoorPaths, type FromHost, isStartMessage } from './messages';

const port = process.parentPort;
let brain: Brain | null = null;
let service: BrainService | null = null;
let doors: (DoorPaths & { cliShimDir?: string }) | null = null;

/** Door launch info for Step 8: the Hive's BrainAccess hands these to each insect run. */
export function currentDoors(): (DoorPaths & { cliShimDir?: string }) | null {
  return doors;
}

const send = (m: FromHost): void => port.postMessage(m);

async function start(m: { dbPath: string; endpoint: string; masterToken: string; doors: DoorPaths }): Promise<void> {
  if (service) return send({ type: 'ready', endpoint: service.endpoint });
  try {
    mkdirSync(dirname(m.dbPath), { recursive: true });
    // A Unix socket left behind by a crashed host would block listen(); named pipes vanish with their process.
    if (process.platform !== 'win32' && existsSync(m.endpoint)) unlinkSync(m.endpoint);
    brain = openBrain(m.dbPath);
    service = await startBrainService({ brain, endpoint: m.endpoint, masterToken: m.masterToken });
    doors = { ...m.doors, ...installCliShims(m.dbPath, m.doors) };
    send({ type: 'ready', endpoint: service.endpoint });
  } catch (err) {
    brain?.close();
    brain = null;
    send({ type: 'failed', message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * `brain` and `brain.cmd` launchers in <userData>/bin; the hive puts this folder first on each insect's PATH.
 * Rewritten every start so they always point at the current app executable. A failure here only
 * disables the CLI door (insects still have MCP), so it never stops the Brain.
 */
function installCliShims(dbPath: string, d: DoorPaths): { cliShimDir?: string } {
  const dir = join(dirname(dbPath), '..', 'bin');
  try {
    writeBrainShims(dir, { command: d.runtime.command, args: [d.brainCli], env: d.runtime.env });
    return { cliShimDir: dir };
  } catch (err) {
    console.error('[brain-host] could not write the brain CLI launchers:', err);
    return {};
  }
}

async function stop(): Promise<void> {
  await service?.close().catch(() => {});
  service = null;
  brain?.close();
  brain = null;
  send({ type: 'stopped' });
  process.exit(0);
}

port.on('message', (e: Electron.MessageEvent) => {
  const m: unknown = e.data;
  if (isStartMessage(m)) void start(m);
  else if (typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'stop') void stop();
});

