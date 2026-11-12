import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { type GuardContext, type Verdict, evaluateCommand, evaluatePath } from './guard';

/**
 * Adapter between Claude Code's PreToolUse hook and the command guard.
 * Claude Code calls the hook before every tool use; the guard's verdict decides whether it runs.
 */

/** Caste network policy (Workspace 06-D7): none, documentation and package sites only, or the open web. */
export type NetworkPolicy = 'none' | 'docs' | 'web';

export type HookPolicy = GuardContext & { network: NetworkPolicy };

export interface PreToolUseInput {
  hook_event_name?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd?: string;
  session_id?: string;
}

const DOCS_HOSTS = [
  'registry.npmjs.org', 'npmjs.com', 'pypi.org', 'files.pythonhosted.org', 'crates.io', 'docs.rs', 'pkg.go.dev',
  'nodejs.org', 'developer.mozilla.org', 'typescriptlang.org', 'react.dev', 'vite.dev', 'vitejs.dev', 'vitest.dev',
  'tailwindcss.com', 'playwright.dev', 'electronjs.org', 'docs.python.org', 'learn.microsoft.com', 'docs.github.com',
  'github.com', 'raw.githubusercontent.com', 'stackoverflow.com', 'ui.shadcn.com', 'zod.dev', 'sqlite.org', 'git-scm.com',
];
const COORDINATION_TOOLS = new Set(['TodoWrite', 'Task', 'Agent', 'ExitPlanMode', 'Skill', 'BashOutput', 'KillShell', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);
const READ_TOOLS: Record<string, string> = { Read: 'file_path', NotebookRead: 'notebook_path', LS: 'path', Glob: 'path', Grep: 'path' };
const WRITE_TOOLS: Record<string, string> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function checkUrl(raw: string | undefined, network: NetworkPolicy): Verdict {
  if (network === 'none') return { decision: 'block', rule: 'network', reason: 'This caste has no internet access.' };
  let url: URL;
  try {
    url = new URL(raw ?? '');
  } catch {
    return { decision: 'block', rule: 'network', reason: 'Not a valid web address.' };
  }
  if (url.protocol !== 'https:') return { decision: 'block', rule: 'network', reason: 'Only https addresses are allowed.' };
  if (network === 'web') return { decision: 'allow' };
  const host = url.hostname.toLowerCase();
  const ok = DOCS_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  return ok ? { decision: 'allow' } : { decision: 'block', rule: 'network', reason: `${host} is not a documentation or package site; this caste can only reach those.` };
}

export function preToolUse(input: PreToolUseInput, policy: HookPolicy): Verdict {
  const t = input.tool_name;
  const ti = input.tool_input ?? {};
  if (t === 'Bash' || t === 'PowerShell') return evaluateCommand(str(ti['command']) ?? '', policy);
  if (t in WRITE_TOOLS) return evaluatePath(str(ti[WRITE_TOOLS[t]!]) ?? '', 'write', policy);
  if (t in READ_TOOLS) {
    const p = str(ti[READ_TOOLS[t]!]);
    return p ? evaluatePath(p, 'read', policy) : { decision: 'allow' };
  }
  if (t === 'WebFetch') return checkUrl(str(ti['url']), policy.network);
  if (t === 'WebSearch') {
    return policy.network === 'none' ? { decision: 'block', rule: 'network', reason: 'This caste has no internet access.' } : { decision: 'allow' };
  }
  if (t.startsWith('mcp__') || COORDINATION_TOOLS.has(t)) return { decision: 'allow' };
  return { decision: 'ask', rule: 'unknown-tool', reason: `The guard does not know the tool "${t}".` };
}

/**
 * Claude Code's hook reply. Insects run headless, so "ask" cannot prompt anyone:
 * it becomes a deny that tells the insect to block its card; the hive then asks the user (Hive 02-D7).
 */
export function toClaudeCodeOutput(v: Verdict): { stdout: string; exitCode: number } {
  const reason =
    v.decision === 'allow'
      ? 'Allowed by the Insectoids guard.'
      : v.decision === 'block'
        ? `Blocked by the Insectoids guard [${v.rule}]: ${v.reason}`
        : `Needs the user's approval [${v.rule}]: ${v.reason} Do not retry or work around this. Set your card to blocked and explain what you need; the Queen will ask the user.`;
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: v.decision === 'allow' ? 'allow' : 'deny',
      permissionDecisionReason: reason,
    },
  };
  return { stdout: JSON.stringify(out), exitCode: 0 };
}

/** Resolve links on disk, for paths that may not exist yet: the nearest existing ancestor is resolved. */
export function fsRealpath(abs: string): string {
  let cur = abs;
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  try {
    return path.join(realpathSync.native(cur), ...rest);
  } catch {
    return abs;
  }
}

/** The hook process entry: stdin JSON from Claude Code, policy from INSECTOIDS_GUARD. Fails closed. */
export function runHook(stdin: string, env: Record<string, string | undefined>, realpath?: (p: string) => string): { stdout: string; exitCode: number } {
  const deny = (reason: string) => toClaudeCodeOutput({ decision: 'block', rule: 'guard-error', reason });
  let policy: HookPolicy;
  try {
    policy = JSON.parse(env['INSECTOIDS_GUARD'] ?? '') as HookPolicy;
    if (!policy.workspace || !policy.home) throw new Error('incomplete');
  } catch {
    return deny('The guard has no policy for this insect, so nothing is allowed.');
  }
  let input: PreToolUseInput;
  try {
    input = JSON.parse(stdin) as PreToolUseInput;
    if (typeof input.tool_name !== 'string') throw new Error('no tool');
  } catch {
    return deny('The guard could not read the tool request.');
  }
  const ctx: HookPolicy = realpath ? { ...policy, workspace: realpath(policy.workspace), realpath } : policy;
  try {
    return toClaudeCodeOutput(preToolUse(input, ctx));
  } catch {
    return deny('The guard hit an error checking this request.');
  }
}
