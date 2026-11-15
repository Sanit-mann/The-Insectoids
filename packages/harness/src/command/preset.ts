import type { EngineId } from '@insectoids/shared';
import type { Effort } from '../claude/args';
import type { RunError } from '../claude/run';
import type { Usage } from '../claude/stream';
import type { ModelTiers } from '../hive/router';
import type { HiveMcpName } from '../opencode/config';

/**
 * The generic "command" engine (Phase 4 B1; Connections 04-D2 "custom command"): any CLI that takes a prompt
 * headless and works in the card's worktree, described declaratively by a preset. The engine never knows a
 * CLI by name; everything it does with one comes from here.
 *
 * Safety (Workspace & Safety 06-D4): a preset is runnable only when it says how to switch off the CLI's own
 * file and shell tools and load the hive's guarded tools over MCP instead (the "policy-and-tools" trick, as for
 * Gemini CLI and OpenCode). Without that its guard is null and the router never sends it work: it waits for
 * container mode.
 */

/** One thing a CLI's JSON-lines output said. Unknown or malformed lines yield nothing. */
export type CommandEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; id?: string; input?: unknown }
  | { kind: 'usage'; usage: Partial<Usage>; model?: string; costUsd?: number }
  | { kind: 'final'; ok: boolean; text?: string; sessionId?: string; model?: string; numTurns?: number; costUsd?: number; errorMessage?: string }
  | { kind: 'error'; message: string; auth?: boolean; quota?: boolean };

/** How the prompt (role brief + task) reaches the CLI. */
export type PromptPassing =
  /** As an argument: after `flag`, or as the last positional argument when flag is null. */
  | { via: 'arg'; flag: string | null }
  /** On standard input (then closed). */
  | { via: 'stdin' }
  /** In a file in the run folder (outside the workspace), whose path follows `flag`. */
  | { via: 'file'; flag: string };

/** One of the hive's MCP servers for a run, already complete (command, arguments, its own environment). */
export interface HiveMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** The hive tools run in the card's workspace. */
  cwd?: string;
}

export type HiveMcpServers = Partial<Record<HiveMcpName, HiveMcpServer>>;

/** What a preset adds to a run to load the hive's MCP servers (and nothing else). */
export interface McpWiring {
  args?: string[];
  env?: Record<string, string>;
  /** Files written into the run's own folder (paths relative to it; never inside the workspace). */
  files?: Array<{ path: string; content: string }>;
}

export interface CommandGuard {
  /**
   * Arguments that switch off every built-in tool able to change files or run commands (and, where the CLI
   * allows, everything except the hive's MCP tools). Never empty for a guarded preset.
   */
  disableBuiltinTools: readonly string[];
  /**
   * Builds the wiring that loads exactly the given MCP servers. Null when the CLI can't load MCP servers:
   * it then only gets read-only work (it can't change anything with its own tools switched off).
   * Throwing refuses the run (e.g. a value the CLI would expand).
   */
  wireMcp: ((servers: HiveMcpServers, run: { runDir: string; platform: NodeJS.Platform }) => McpWiring) | null;
  /**
   * Call wireMcp on every run, also with no servers: for a CLI whose guard itself lives in the per-run config
   * the wiring writes (e.g. a settings file that denies its own tools). Then disableBuiltinTools may be empty.
   */
  wireAlways?: boolean;
}

export interface CommandPreset {
  id: EngineId;
  name: string;
  vendor: string;
  /** Program name on PATH, without extension (e.g. "copilot"). */
  executable: string;
  /** Programs of that name that aren't this CLI (e.g. VS Code's `copilot` stand-in): skipped when searching PATH. */
  ignorePaths?: RegExp;
  /**
   * The native program behind the CLI's npm launcher script, when it has one: the hive then starts it
   * directly (no Node.js hop in between). Null: start the script with Node.js as usual.
   */
  resolveScript?: (script: string, exists: (path: string) => boolean, platform: NodeJS.Platform, arch?: string) => string | null;
  /** e.g. { args: ['--version'], pattern: /(\d+\.\d+\.\d+)/, minimum: '1.2.0' }; the pattern's group 1 is the version. */
  version: { args: readonly string[]; pattern: RegExp; minimum: string };
  /** The official install command, shown for the user to copy (or run with consent). */
  install: { command: string; note: string } | null;
  /** How to sign in, always in the CLI's own login. The hive never sees passwords or tokens. */
  signIn: { command: string; note: string } | null;
  privacyNote: string | null;
  prompt: PromptPassing;
  /** Always-on flags for a headless, non-interactive run (never anything that auto-approves without the guard). */
  headlessArgs: readonly string[];
  /**
   * The model flag and the CLI's model names by tier; null when it has no model choice. `args`, when set,
   * turns a tier's name into the arguments themselves (e.g. "auto:balance" → --model auto --auto-tier balance).
   */
  model: { flag: string; tiers: ModelTiers; args?: (model: string) => string[] } | null;
  /** The effort flag and the CLI's word for each of the hive's levels (a level left out passes nothing). */
  effort?: {
    flag: string;
    values: Partial<Record<Effort, string>>;
    /** Models that take no effort flag (Copilot's Auto refuses one): nothing is passed for them. */
    skipFor?: (model: string) => boolean;
  };
  /** A turn-limit flag, if the CLI has one. */
  maxTurnsFlag?: string;
  /**
   * A CLI that writes its token counts to a file at the end instead of in its output: the flag that names the
   * file (in the run folder) and how to read it. Null from parse = nothing usable.
   */
  usageFile?: { flag: string; parse: (json: unknown) => { usage: Partial<Usage>; models?: string[]; costUsd?: number } | null };
  /** How to read stdout: plain text, or JSON lines through the preset's own parser. */
  output: { format: 'text' } | { format: 'jsonl'; parse: (line: string) => CommandEvent[] };
  /**
   * Sign-in state without spending tokens and without reading credential files: run these arguments and look
   * for the pattern in the output. Absent: the hive can't tell, so a sign-in problem shows on the first run.
   */
  signedInCheck?: { args: readonly string[]; signedIn: RegExp };
  guard: CommandGuard | null;
  /** For an unguarded preset: why, in plain words (shown after "can't be guarded yet"). */
  unguardedWhy?: string;
  /** Flags that auto-approve or bypass safety; the run is refused if any argument is one of them. */
  forbiddenArgs: readonly string[];
  reportsCost: boolean;
  /** Runs are paid by the user's plan (no extra charge; they count toward its usage limits). */
  subscription?: boolean;
  /** When it reports no cost: USD per million tokens for the hive's estimate (absent: 0, marked estimated). */
  pricePerMTok?: { input: number; output: number };
  /** Text in its output or errors that means it is signed out. */
  authHint?: RegExp;
  /** Exit codes with a known meaning (others: 0 ok, anything else a crash). */
  exitCodes?: Readonly<Record<number, RunError>>;
  /** Environment variables never passed to it (the hive's own are always removed). */
  scrubEnv?: readonly string[];
  /** A person ran this preset against the real CLI and checked it. Untested presets say so on the card. */
  tested: boolean;
}

/** True when an argument is a forbidden flag, also in its `--flag=value` form. */
export function isForbiddenArg(arg: string, forbidden: readonly string[]): boolean {
  return forbidden.some((f) => arg === f || arg.startsWith(`${f}=`));
}

/**
 * Why a preset can't take guarded work, in plain words; null when it can. The router relies on this through
 * the adapter's capabilities: no guard, no work.
 */
export function unguardedReason(p: CommandPreset): string | null {
  if (!p.guard) return `${p.name} can't be guarded yet; it will run inside a container once container mode exists.${p.unguardedWhy ? ` ${p.unguardedWhy}` : ''}`;
  if (p.guard.disableBuiltinTools.length === 0 && !(p.guard.wireAlways && p.guard.wireMcp)) return `${p.name}'s preset doesn't say how to switch off its own tools, so it can't be guarded yet.`;
  const bad = [...p.headlessArgs, ...p.guard.disableBuiltinTools].find((a) => isForbiddenArg(a, p.forbiddenArgs));
  if (bad) return `${p.name}'s preset passes "${bad}", which would approve every action without the command guard.`;
  return null;
}
