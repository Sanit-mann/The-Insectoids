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
import { WebhookCallSchema } from '@insectoids/shared';
import { type BrainService, startBrainService } from '@insectoids/brain-service';
import { HiveManager, e2eReadyEngines } from './hive-manager';
import { MeaningSearch } from './meaning-search';
import type { LlmAccess, LlmUsage, ReadyProvider } from '@insectoids/harness';
import { writeHookLauncher } from '../main/hook-launcher';
import type { ServiceAccess, ServiceTicket } from '@insectoids/harness';
import { type DoorPaths, type FromHost, type HostMethod, type HostRequestMethod, type ToHost, isHostReply, isRpcMessage, isStartMessage } from './messages';

const port = process.parentPort;
let brain: Brain | null = null;
let service: BrainService | null = null;
let hive: HiveManager | null = null;
let meaning: MeaningSearch | null = null;

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

/** OpenCode's model providers (A4): passes and provider list from main; keys never leave main. */
function llmAccess(): LlmAccess {
  return {
    issue: async (runId, providerId) => (await requestMain('broker.issueLlm', { runId, providerId })) as { baseUrl: string; pass: string },
    usage: async (pass) => (await requestMain('broker.llmUsage', { pass })) as LlmUsage | null,
    revoke: async (pass) => {
      await requestMain('broker.revoke', { token: pass });
    },
  };
}

async function readyProviders(): Promise<ReadyProvider[]> {
  const list = await requestMain('providers.ready');
  return Array.isArray(list) ? (list as ReadyProvider[]) : [];
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
    // Meaning search (Phase 2 B1): off until the user switches it on; then the model runs in this process.
    const ms = new MeaningSearch({
      brain,
      settingsFile: join(m.hive.userDataDir, 'meaning-search.json'),
      modelsDir: m.hive.modelsDir ?? join(m.hive.userDataDir, 'models'),
      ...(m.doors.ortWasmDir ? { wasmDir: m.doors.ortWasmDir } : {}),
      onChange: () => send({ type: 'push', push: { type: 'changed', reason: 'meaning-search' } }),
      log: (line) => console.log(line),
    });
    meaning = ms;
    const svc = await startBrainService({ brain, endpoint: m.endpoint, masterToken: m.masterToken, embedQuery: (text) => ms.embedQuery(text) });
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
      llm: llmAccess(),
      providers: readyProviders,
      meaning: ms,
      // The code map (B4): tree-sitter's WASM comes from the door paths (the bundle can't resolve the package).
      codeMap: { ...(m.doors.codemapWasmDir ? { wasmDir: m.doors.codemapWasmDir } : {}) },
      push: (push) => send({ type: 'push', push }),
      log: (line) => console.log(line),
      // e2e only: seed B2 records, and move the decay clock forward to test fading without waiting.
      ...(process.env['INSECTOIDS_E2E'] === '1' && process.env['INSECTOIDS_E2E_BRAIN_SEED'] === '1' ? { seedBrainForE2E: true } : {}),
      ...(process.env['INSECTOIDS_E2E'] === '1' && process.env['INSECTOIDS_E2E_TIDY_SHIFT_DAYS']
        ? { tidy: { clockShiftDays: Number(process.env['INSECTOIDS_E2E_TIDY_SHIFT_DAYS']) || 0 } }
        : {}),
      // e2e only (C5): engines that show as ready on the Engines step (display only; the scripted engine runs everything).
      ...(process.env['INSECTOIDS_E2E'] === '1' && process.env['INSECTOIDS_E2E_READY_ENGINES']
        ? { e2eReadyEngines: e2eReadyEngines(process.env['INSECTOIDS_E2E_READY_ENGINES']) }
        : {}),
      // e2e only (Phase 3 A1): interval minutes count as seconds, so a 15-minute cadence fires after 15 s.
      ...(process.env['INSECTOIDS_E2E'] === '1' && process.env['INSECTOIDS_E2E_CADENCE_SECONDS'] === '1' ? { cadence: { intervalUnitMs: 1_000, recheckMs: 2_000, settleMs: 1_000 } } : {}),
      // e2e only (Phase 3 A5): asks closer together than this many ms count as one occasion for cadence proposals.
      ...(process.env['INSECTOIDS_E2E'] === '1' && /^\d+$/.test(process.env['INSECTOIDS_E2E_PROPOSAL_RETRY_MS'] ?? '')
        ? { cadenceProposals: { retryWindowMs: Number(process.env['INSECTOIDS_E2E_PROPOSAL_RETRY_MS']) } }
        : {}),
      // e2e only (B3): the demo Inspector fails C-01 once, so a lesson is learned.
      ...(process.env['INSECTOIDS_E2E'] === '1' && process.env['INSECTOIDS_E2E_INSPECTOR_FAILS_FIRST'] === '1' ? { demoInspectorFailsFirst: true } : {}),
    });
    await hive.init();
    await ms.init();
    send({ type: 'ready', endpoint: svc.endpoint });
  } catch (err) {
    await meaning?.dispose().catch(() => {});
    meaning = null;
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
    case 'codeLookup':
      // Validated in main against CodeLookupRequestSchema before it gets here.
      return hive.codeLookup(params as Parameters<HiveManager['codeLookup']>[0]);
    // Brain screens (Phase 2 B5): requests are validated in main and parsed again in the HiveManager.
    case 'brainGraph':
      return hive.brainGraph(params as Parameters<HiveManager['brainGraph']>[0]);
    case 'brainDashboard':
      return hive.brainDashboard();
    case 'budgets':
      return hive.budgets();
    case 'cadenceRuns':
      // Validated in main against CadenceRunsRequestSchema.
      return hive.cadenceRuns(params as Parameters<HiveManager['cadenceRuns']>[0]);
    case 'digest':
      return hive.digest();
    case 'wake':
      hive.wake();
      return null;
    case 'webhookCall':
      // Validated in main against WebhookCallSchema, and again here (the call carries outside content).
      return hive.webhookCall(WebhookCallSchema.parse(params));
    case 'setBackupDir': {
      // Phase 3 A5: checked again in the HiveManager (a non-empty full path).
      const dir = (params as { dir?: unknown } | null)?.dir;
      if (typeof dir !== 'string') throw new Error('setBackupDir needs a dir.');
      hive.setBackupDir(dir);
      return null;
    }
    case 'engineCard':
      return hive.engineCard(String((params as { id?: unknown })?.id ?? ''));
    case 'e2eEngineInstalled': {
      if (process.env['INSECTOIDS_E2E'] !== '1') throw new Error('Only available in end-to-end tests.');
      await hive.e2eEngineInstalled(String((params as { id?: unknown })?.id ?? ''));
      return null;
    }
    case 'brainEdit':
      return hive.brainEdit(params as Parameters<HiveManager['brainEdit']>[0]);
    case 'e2eAgentEdit': {
      // e2e only: refused unless this host itself runs under INSECTOIDS_E2E=1 (checked again in the HiveManager).
      if (process.env['INSECTOIDS_E2E'] !== '1') throw new Error('Only available in end-to-end tests.');
      const p = params as { id?: unknown; body?: unknown };
      if (typeof p?.id !== 'string' || typeof p.body !== 'string') throw new Error('e2eAgentEdit needs an id and a body.');
      hive.e2eAgentEdit(p.id, p.body);
      return null;
    }
    // Library screen (Phase 2 C1): requests are validated in main and parsed again in the HiveManager.
    case 'libraryCastes':
      return hive.libraryCastes();
    case 'librarySearch':
      return hive.librarySearch(params as Parameters<HiveManager['librarySearch']>[0]);
    case 'libraryItem':
      return hive.libraryItem(params as string);
    case 'libraryImport':
      // main passes the folder the user picked (or the e2e fixture path).
      return hive.libraryImport((params as { path: string }).path);
    case 'setLimits':
      // Built in main from the shared PRESETS table; checked again by setLimits.
      hive.setLimits(params as Parameters<HiveManager['setLimits']>[0]);
      return hive.limits;
    default:
      throw new Error(`Unknown host method ${String(method)}`);
  }
}

async function stop(): Promise<void> {
  await meaning?.dispose().catch(() => {});
  meaning = null;
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
