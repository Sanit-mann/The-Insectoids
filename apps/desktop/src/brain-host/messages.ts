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
}

/** Host RPC methods (main -> host). Inputs and outputs are validated in main against the shared schemas. */
export type HostMethod = 'snapshot' | 'command' | 'changes' | 'project' | 'brainRecent' | 'setLimits';

export type ToHost =
  | { type: 'start'; dbPath: string; endpoint: string; masterToken: string; doors: DoorPaths; hive: HiveSetup }
  | { type: 'stop' }
  | { type: 'rpc'; id: number; method: HostMethod; params?: unknown };

export type FromHost =
  | { type: 'ready'; endpoint: string }
  | { type: 'failed'; message: string }
  | { type: 'stopped' }
  | { type: 'rpc-result'; id: number; ok: true; result: unknown }
  | { type: 'rpc-result'; id: number; ok: false; error: string }
  | { type: 'push'; push: HivePush };

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

export function isRpcMessage(m: unknown): m is Extract<ToHost, { type: 'rpc' }> {
  if (typeof m !== 'object' || m === null) return false;
  const o = m as Record<string, unknown>;
  return o['type'] === 'rpc' && typeof o['id'] === 'number' && typeof o['method'] === 'string';
}
