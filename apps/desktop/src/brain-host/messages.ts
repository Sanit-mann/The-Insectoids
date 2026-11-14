/**
 * Messages between the main process and the Brain host over the utility process's parentPort.
 * The master token travels only here: never in argv or the environment, where child processes
 * and process listings could see it.
 */
import type { HivePush } from '@insectoids/shared';
import type { HiveLimits } from './hive-manager';

export interface DoorPaths {
  /** Runtime for door processes: the app's own executable run as Node. */
  runtime: { command: string; env: Record<string, string> };
  guardHook: string;
  brainMcp: string;
  brainCli: string;
  /** Guarded shell and file tools over MCP, for engines without a fail-closed hook (Gemini CLI). */
  hiveTools: string;
  /** The services door: `call_service` over MCP, through the secret broker in main (Phase 2 A3). */
  servicesMcp: string;
  /** onnxruntime-web's WASM folder, for meaning search's model (Phase 2 B1). */
  ortWasmDir?: string;
  /** @vscode/tree-sitter-wasm's wasm folder (runtime + grammars), for the code map (Phase 2 B4). */
  codemapWasmDir?: string;
}

/** What the hive host needs besides the Brain (Phase 1 Step 8: the Hive lives in this process). */
export interface HiveSetup {
  /** The app's profile folder: settings.json, hive data, worktrees, prompts. */
  userDataDir: string;
  /** The agents/skills library (repo `library/` in dev). */
  libraryDir: string;
  /** 'fake' = scripted demo engine (INSECTOIDS_ENGINE=fake): no AI calls, no tokens. */
  engine: 'claude' | 'fake';
  /** e2e only: use this folder as the project instead of settings.json. */
  project?: string;
  /** Limits from the user's safety preset (Onboarding 08-D7); Balanced when absent. */
  limits?: HiveLimits;
  /** Where meaning-search models live (Phase 2 B1). Default <userData>/models; e2e may point at a downloaded copy. */
  modelsDir?: string;
}

/** Host RPC methods (main -> host). Inputs and outputs are validated in main against the shared schemas. */
export type HostMethod =
  | 'snapshot'
  | 'command'
  | 'changes'
  | 'project'
  | 'brainRecent'
  | 'setLimits'
  | 'codeLookup'
  // Library imports (Phase 2 C3): the folder was chosen in main.
  | 'libraryImport'
  // Brain screens (Phase 2 B5). 'e2eAgentEdit' works only when the host runs under INSECTOIDS_E2E=1.
  | 'brainGraph'
  | 'brainDashboard'
  | 'brainEdit'
  | 'e2eAgentEdit'
  // Library screen (Phase 2 C1): the castes and the catalog, read-only.
  | 'libraryCastes'
  | 'librarySearch'
  | 'libraryItem'
  // Budgets screen (Phase 2 C4), read-only.
  | 'budgets'
  // Cadence run history (Phase 3 A1), read-only.
  | 'cadenceRuns'
  // The computer woke from sleep (Phase 3 A2): main tells the host so owed cadence runs happen at once.
  | 'wake'
  // A webhook call (Cadence 05-D4; Phase 3 A4): main checked the secret, size and rate; params WebhookCall,
  // result WebhookReply (what main answers the caller).
  | 'webhookCall'
  // Where Brain backups go (Cadence 05-D7; Phase 3 A5): params { dir } (a full path); main sends it at every host
  // start and whenever the user changes the folder.
  | 'setBackupDir'
  // Engine install (C4): main reads the engine's card (its official install command) from the host.
  // 'e2eEngineInstalled' works only when the host runs under INSECTOIDS_E2E=1.
  | 'engineCard'
  | 'e2eEngineInstalled';

/**
 * Requests the host makes to main (the reverse direction): the secret broker and the Vault live in
 * main, and the hive asks it for a capability token per run. No key ever crosses this channel.
 */
export type HostRequestMethod =
  | 'broker.available'
  | 'broker.issue'
  | 'broker.revoke'
  /** A4: a per-run pass for one engine run on one model provider → { baseUrl, pass }. */
  | 'broker.issueLlm'
  /** A4: what the broker saw for a pass → { model, input, output, cacheRead, calls }. */
  | 'broker.llmUsage'
  /** A4: enabled providers that passed their test, in the user's order → Array<{ id, label, local, models }>. */
  | 'providers.ready';

export type ToHost =
  | { type: 'start'; dbPath: string; endpoint: string; masterToken: string; doors: DoorPaths; hive: HiveSetup }
  | { type: 'stop' }
  | { type: 'rpc'; id: number; method: HostMethod; params?: unknown }
  | { type: 'host-reply'; id: number; ok: true; result: unknown }
  | { type: 'host-reply'; id: number; ok: false; error: string };

export type FromHost =
  | { type: 'ready'; endpoint: string }
  | { type: 'failed'; message: string }
  | { type: 'stopped' }
  | { type: 'rpc-result'; id: number; ok: true; result: unknown }
  | { type: 'rpc-result'; id: number; ok: false; error: string }
  | { type: 'push'; push: HivePush }
  | { type: 'host-request'; id: number; method: HostRequestMethod; params?: unknown };

export function isStartMessage(m: unknown): m is Extract<ToHost, { type: 'start' }> {
  if (typeof m !== 'object' || m === null) return false;
  const o = m as Record<string, unknown>;
  return (
    o['type'] === 'start' &&
    typeof o['dbPath'] === 'string' &&
    typeof o['endpoint'] === 'string' &&
    typeof o['masterToken'] === 'string' &&
    typeof o['doors'] === 'object' &&
    o['doors'] !== null &&
    typeof o['hive'] === 'object' &&
    o['hive'] !== null
  );
}

export function isHostReply(m: unknown): m is Extract<ToHost, { type: 'host-reply' }> {
  if (typeof m !== 'object' || m === null) return false;
  const o = m as Record<string, unknown>;
  return o['type'] === 'host-reply' && typeof o['id'] === 'number' && typeof o['ok'] === 'boolean';
}

export function isRpcMessage(m: unknown): m is Extract<ToHost, { type: 'rpc' }> {
  if (typeof m !== 'object' || m === null) return false;
  const o = m as Record<string, unknown>;
  return o['type'] === 'rpc' && typeof o['id'] === 'number' && typeof o['method'] === 'string';
}
