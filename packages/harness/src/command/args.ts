import { isAbsolute, join, normalize } from 'node:path';
import type { Effort } from '../claude/args';
import { type CommandPreset, type HiveMcpServers, isForbiddenArg, unguardedReason } from './preset';

/** What one run passes to the CLI: arguments, extra environment, files for the run folder, and stdin. */
export interface CommandInvocation {
  args: string[];
  env: Record<string, string>;
  /** Relative to the run folder (outside every workspace). */
  files: Array<{ path: string; content: string }>;
  /** The prompt on standard input, or null when it goes as an argument or a file. */
  stdin: string | null;
}

export interface CommandArgsInput {
  prompt: string;
  /** The CLI's model name for the route's tier; null passes no model flag. */
  model: string | null;
  effort?: Effort;
  maxTurns?: number;
  /** The run's MCP servers (the hive tools only when the run may change files). */
  mcpServers: HiveMcpServers;
  /** No hive tools: nothing in the run can change files. */
  readOnly: boolean;
  runDir: string;
  platform?: NodeJS.Platform;
}

/** Windows command lines stop at 32,767 characters; a prompt this long goes on stdin or in a file instead. */
export const MAX_PROMPT_ARG = 30_000;
export const PROMPT_FILE = 'prompt.md';
/** Where a CLI with a usage file writes its token counts (in the run folder). */
export const USAGE_FILE = 'usage.json';

/**
 * Builds one run's command line from the preset. Throws (with plain words) instead of building anything
 * unsafe: an unguarded preset, a forbidden flag anywhere, a value that would be read as a flag, or a wiring
 * file that would land outside the run folder.
 */
export function buildCommandInvocation(p: CommandPreset, o: CommandArgsInput): CommandInvocation {
  const why = unguardedReason(p);
  if (why || !p.guard) throw new Error(why ?? `${p.name} can't be guarded yet.`);
  if (!o.readOnly && !p.guard.wireMcp) throw new Error(`${p.name} can't load the hive tools, so it can only do read-only work.`);

  // The hive tools change files: never in a read-only run, whatever the caller passed.
  const servers: HiveMcpServers = { ...o.mcpServers };
  if (o.readOnly) delete servers.hive;
  const wiring = p.guard.wireMcp && (Object.keys(servers).length || p.guard.wireAlways) ? p.guard.wireMcp(servers, { runDir: o.runDir, platform: o.platform ?? process.platform }) : {};

  const value = (what: string, v: string): string => {
    if (v.startsWith('-')) throw new Error(`The ${what} "${v}" starts with "-", so ${p.name} would read it as a flag. Refusing to run.`);
    return v;
  };
  const args = [...p.headlessArgs, ...p.guard.disableBuiltinTools, ...(wiring.args ?? [])];
  if (p.model && o.model) {
    if (p.model.args) for (const a of p.model.args(value('model', o.model))) args.push(a);
    else args.push(p.model.flag, value('model', o.model));
  }
  const effort = o.effort && !(o.model && p.effort?.skipFor?.(o.model)) && p.effort?.values[o.effort];
  if (p.effort && effort) args.push(p.effort.flag, value('effort', effort));
  if (p.maxTurnsFlag && o.maxTurns) args.push(p.maxTurnsFlag, String(Math.max(1, Math.floor(o.maxTurns))));
  if (p.usageFile) args.push(p.usageFile.flag, join(o.runDir, USAGE_FILE));
  const bad = args.find((a) => isForbiddenArg(a, p.forbiddenArgs));
  if (bad) throw new Error(`Refusing "${bad}": it would approve every action without the command guard.`);

  const files = (wiring.files ?? []).map((f) => {
    const rel = normalize(f.path);
    if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error(`${p.name}'s wiring file "${f.path}" would land outside the run folder. Refusing to run.`);
    return { path: rel, content: f.content };
  });

  let stdin: string | null = null;
  if (p.prompt.via === 'stdin') {
    stdin = o.prompt;
  } else if (p.prompt.via === 'file') {
    files.push({ path: PROMPT_FILE, content: o.prompt });
    args.push(p.prompt.flag, join(o.runDir, PROMPT_FILE));
  } else {
    if (o.prompt.length > MAX_PROMPT_ARG) {
      throw new Error(`The prompt is ${o.prompt.length.toLocaleString('en-US')} characters, too long to pass to ${p.name} as an argument.`);
    }
    // The prompt is outside text (the user's goal): as a positional argument it must never read as a flag.
    if (p.prompt.flag) args.push(p.prompt.flag, o.prompt);
    else args.push(value('prompt', o.prompt));
  }
  return { args, env: { ...(wiring.env ?? {}) }, files, stdin };
}
