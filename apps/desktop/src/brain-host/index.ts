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
import type { ServiceAccess, ServiceTicket } from '@insectoids/harness';
import { type DoorPaths, type FromHost, type HostMethod, type HostRequestMethod, type ToHost, isHostReply, isRpcMessage, isStartMessage } from './messages';

const port = process.parentPort;
let brain: Brain | null = null;
let service: BrainService | null = null;
let hive: HiveManager | null = null;

const send = (m: FromHost): void => port.postMessage(m);

/** Requests to main (the secret broker lives there, with the Vault). */
const MAIN_TIMEOUT_MS = 15_000;
let mainId = 0;
const mainPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
function requestMain(method: HostRequestMethod, params?: unknown): Promise<unknown> {
  const id = ++mainId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      mainPending.delete(id);
      reject(new Error('The app did not answer the request for outside services.'));
    }, MAIN_TIMEOUT_MS);
    mainPending.set(id, { resolve, reject, timer });
    send({ type: 'host-request', id, method, ...(params === undefined ? {} : { params }) });
  });
}

/** Outside services for the hive: tokens come from the broker in main; the door is the services MCP bundle. */
function serviceAccess(d: DoorPaths): ServiceAccess {
  return {
    available: async () => (await requestMain('broker.available')) as Array<{ id: string; description: string }>,
    issue: async (g) => (await requestMain('broker.issue', g)) as ServiceTicket,
    revoke: async (token) => {
      await requestMain('broker.revoke', { token });
    },
    door: { runtime: d.runtime, mcpScript: d.servicesMcp },
  };
}

async function start(m: Extract<ToHost, { type: 'start' }>): Promise<void> {
  if (service) return send({ type: 'ready', endpoint: service.endpoint });
  try {
    mkdirSync(dirname(m.dbPath), { recursive: true });
    // A Unix socket left behind by a crashed host would block listen(); named pipes vanish with their process.
    if (process.platform !== 'win32' && existsSync(m.endpoint)) unlinkSync(m.endpoint);
    brain = openBrain(m.dbPath);
    const svc = await startBrainService({ brain, endpoint: m.endpoint, masterToken: m.masterToken });
    service = svc;
    // Launchers live in the app profile, never next to a Brain folder the user picked.
    const doors = { ...m.doors, ...installCliShims(m.hive.userDataDir, m.doors), ...installHookLauncher(m.hive.userDataDir, m.doors) };
    hive = new HiveManager({
      brain,
      tokens: { endpoint: svc.endpoint, issue: (g) => svc.issueAgentToken(g), revoke: (t) => svc.revokeToken(t) },
      doors,
      userDataDir: m.hive.userDataDir,
      libraryDir: m.hive.libraryDir,
      engine: m.hive.engine,
      ...(m.hive.project ? { project: m.hive.project } : {}),
      ...(m.hive.limits ? { limits: m.hive.limits } : {}),
      services: serviceAccess(m.doors),
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
function installCliShims(userDataDir: string, d: DoorPaths): { cliShimDir?: string } {
  const dir = join(userDataDir, 'bin');
  try {
    writeBrainShims(dir, { command: d.runtime.command, args: [d.brainCli], env: d.runtime.env });
    return { cliShimDir: dir };
  } catch (err) {
    console.error('[brain-host] could not write the brain CLI launchers:', err);
    return {};
  }
}

/** Launcher that runs the guard hook as Node without putting ELECTRON_RUN_AS_NODE in Claude's environment. */
function installHookLauncher(userDataDir: string, d: DoorPaths): { hookLauncher?: { command: string; args: string[] } } {
  try {
    return { hookLauncher: writeHookLauncher(join(userDataDir, 'hooks'), d.runtime, d.guardHook) };
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
    case 'setLimits':
      // Built in main from the shared PRESETS table; checked again by setLimits.
      hive.setLimits(params as Parameters<HiveManager['setLimits']>[0]);
      return hive.limits;
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
  if (isHostReply(m)) {
    const p = mainPending.get(m.id);
    if (!p) return;
    mainPending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.error));
    return;
  }
  if (isRpcMessage(m)) {
    rpc(m.method, m.params).then(
      (result) => send({ type: 'rpc-result', id: m.id, ok: true, result }),
      (err: unknown) => send({ type: 'rpc-result', id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  } else if (isStartMessage(m)) void start(m);
  else if (typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'stop') void stop();
});
