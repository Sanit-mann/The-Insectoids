import { delimiter } from 'node:path';
import { type AgentRole, isInsectRole } from './router';

/**
 * Brain access for insects (Memory 01-D5: the doors). The hive mints a token per run, scoped to the
 * agent, the goal's project shelf and read or read-write; the engine hands the tool the MCP door and the
 * `brain` command. The token dies when the run ends.
 *
 * Kept as plain interfaces so the harness does not depend on the Brain service package: the app wires
 * a real provider (the Brain host's `issueAgentToken`), tests can use the real service or a stub.
 */

/** Environment variable names the doors read (same as @insectoids/brain-service BRAIN_ENV). */
export const BRAIN_ENV_ENDPOINT = 'INSECTOIDS_BRAIN_ENDPOINT';
export const BRAIN_ENV_TOKEN = 'INSECTOIDS_BRAIN_TOKEN';

export interface BrainGrant {
  agentId: string;
  shelf: string;
  write: boolean;
  /** Ties the run's reads to its card attempt, so a pass credits what helped (B2). Insects only. */
  readKey?: string;
}

export interface BrainTicket {
  token: string;
  revoke(): void | Promise<void>;
}

/** How to start the door processes. */
export interface BrainDoors {
  /** The JavaScript runtime, e.g. { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } } inside Electron. */
  runtime: { command: string; args?: string[]; env?: Record<string, string> };
  /** The bundled MCP server (packages/brain-mcp dist/brain-mcp.mjs). */
  mcpScript: string;
  /** Folder holding the `brain` / `brain.cmd` launchers; put first on the insect's PATH. */
  cliShimDir?: string;
}

export interface BrainAccess {
  /** The Brain service endpoint (named pipe or Unix socket). */
  endpoint: string;
  doors: BrainDoors;
  grant(g: BrainGrant): BrainTicket | Promise<BrainTicket>;
}

/** What one engine run gets. */
export interface RunBrain {
  endpoint: string;
  token: string;
  write: boolean;
  doors: BrainDoors;
}

/**
 * Who may write to the Brain.
 * - Insects (every caste) write: what they learn about the project is the point of a shared Brain.
 *   Their facts and decisions still start unconfirmed/proposed (01-D3), so the user stays in charge.
 * - The Queen only reads: in Phase 1 she plans, and the hive itself records her goal and plan.
 * - The Inspector only reads: a verifier that can also write memory could talk itself into a pass;
 *   the hive records the verdict as the Inspector's outcome instead.
 */
export function brainWriteAccess(role: AgentRole): boolean {
  return isInsectRole(role);
}

export function brainEnv(b: RunBrain): Record<string, string> {
  return { [BRAIN_ENV_ENDPOINT]: b.endpoint, [BRAIN_ENV_TOKEN]: b.token };
}

/** MCP config for one run: just the Brain door (passed with --strict-mcp-config, so nothing else leaks in). */
export function brainMcpConfig(b: RunBrain): { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> } {
  return {
    mcpServers: {
      brain: {
        command: b.doors.runtime.command,
        args: [...(b.doors.runtime.args ?? []), b.doors.mcpScript],
        env: { ...b.doors.runtime.env, ...brainEnv(b) },
      },
    },
  };
}

/**
 * Prepends a folder to PATH, keeping the base environment's own spelling of the key
 * (Windows uses `Path`; a second `PATH` key would make the child's PATH unpredictable).
 */
export function prependPath(dir: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const key = Object.keys(base).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const current = base[key];
  return { [key]: current ? `${dir}${delimiter}${current}` : dir };
}

/** Everything the run's process environment needs for the Brain (the MCP door gets its own copy via the config). */
export function brainRunEnv(b: RunBrain, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    ...brainEnv(b),
    ...(b.doors.cliShimDir ? prependPath(b.doors.cliShimDir, base) : {}),
  };
}
