/**
 * The Brain host: an Electron utilityProcess and the ONLY process that opens brain.db (single writer,
 * Memory 01-D14, Tech stack 09). It runs the Brain service that every door (MCP, `brain` CLI, and later
 * the local HTTP API) talks to.
 *
 * It is also the **hive host** (decided in Step 7, done in Step 8): the Hive runtime lives here and
 * shares this one Brain instance, so the database keeps exactly one writer. The main process never
 * opens brain.db; it reaches the Brain through the service with the master token, and the hive
 * through the typed RPC below.
 */
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Brain, openBrain } from '@insectoids/brain';
import { writeBrainShims } from '@insectoids/brain-cli/shims';
import { type BrainService, startBrainService } from '@insectoids/brain-service';
import { HiveManager } from './hive-manager';
import { writeHookLauncher } from '../main/hook-launcher';
import { type DoorPaths, type FromHost, type HostMethod, type ToHost, isRpcMessage, isStartMessage } from './messages';

const port = process.parentPort;
let brain: Brain | null = null;
let service: BrainService | null = null;
let hive: HiveManager | null = null;

const send = (m: FromHost): void => port.postMessage(m);

async function start(m: Extract<ToHost, { type: 'start' }>): Promise<void> {
  if (service) return send({ type: 'ready', endpoint: service.endpoint });
  try {
    mkdirSync(dirname(m.dbPath), { recursive: true });
    // A Unix socket left behind by a crashed host would block listen(); named pipes vanish with their process.
    if (process.platform !== 'win32' && existsSync(m.endpoint)) unlinkSync(m.endpoint);
    brain = openBrain(m.dbPath);
    const svc = await startBrainService({ brain, endpoint: m.endpoint, masterToken: m.masterToken });
    service = svc;
    const doors = { ...m.doors, ...installCliShims(m.dbPath, m.doors), ...installHookLauncher(m.dbPath, m.doors) };
    hive = new HiveManager({
      brain,
      tokens: { endpoint: svc.endpoint, issue: (g) => svc.issueAgentToken(g), revoke: (t) => svc.revokeToken(t) },
      doors,
      userDataDir: m.hive.userDataDir,
      libraryDir: m.hive.libraryDir,
      engine: m.hive.engine,
      ...(m.hive.project ? { project: m.hive.project } : {}),
      push: (push) => send({ type: 'push', push }),
      log: (line) => console.log(line),
    });
    await hive.init();
    send({ type: 'ready', endpoint: svc.endpoint });
  } catch (err) {
    await hive?.dispose().catch(() => {});
    hive = null;
    await service?.close().catch(() => {});
    service = null;
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

/** Launcher that runs the guard hook as Node without putting ELECTRON_RUN_AS_NODE in Claude's environment. */
function installHookLauncher(dbPath: string, d: DoorPaths): { hookLauncher?: { command: string; args: string[] } } {
  try {
    return { hookLauncher: writeHookLauncher(join(dirname(dbPath), '..', 'hooks'), d.runtime, d.guardHook) };
  } catch (err) {
    console.error('[brain-host] could not write the guard hook launcher:', err);
    return {};
  }
}

async function rpc(method: HostMethod, params: unknown): Promise<unknown> {
  if (!hive) throw new Error('The hive is not running yet.');
  switch (method) {
    case 'snapshot':
      return hive.snapshot();
    case 'command':
      // Validated in main against HiveCommandSchema before it gets here.
      return hive.command(params as Parameters<HiveManager['command']>[0]);
    case 'changes':
      return hive.changes(params as Parameters<HiveManager['changes']>[0]);
    case 'project':
      return hive.project;
    case 'brainRecent':
      return hive.brainRecent((params ?? {}) as Parameters<HiveManager['brainRecent']>[0]);
    default:
      throw new Error(`Unknown host method ${String(method)}`);
  }
}

async function stop(): Promise<void> {
  await hive?.dispose().catch(() => {});
  hive = null;
  await service?.close().catch(() => {});
  service = null;
  brain?.close();
  brain = null;
  send({ type: 'stopped' });
  process.exit(0);
}

port.on('message', (e: Electron.MessageEvent) => {
  const m: unknown = e.data;
  if (isRpcMessage(m)) {
    rpc(m.method, m.params).then(
      (result) => send({ type: 'rpc-result', id: m.id, ok: true, result }),
      (err: unknown) => send({ type: 'rpc-result', id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  } else if (isStartMessage(m)) void start(m);
  else if (typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'stop') void stop();
});
