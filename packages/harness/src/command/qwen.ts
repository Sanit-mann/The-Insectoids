import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { HiveMcpName } from '../opencode/config';
import type { CommandEvent, CommandPreset, HiveMcpServers, McpWiring } from './preset';

/**
 * Qwen Code (Phase 4 B4), on the generic command engine. Written from Qwen Code's own docs on 2026-11-15
 * (qwenlm.github.io/qwen-code-docs: settings, headless, auth, approval mode, hooks; docs for npm 0.27.4) and
 * docs/research/engine-clis.md §4. The install is pinned to 0.26.5 (the 14-day rule); every setting and flag
 * the guard uses was checked in Qwen Code's source at v0.26.5. Settings lists such as permissions.deny and
 * tools.disabled are unions across scopes, so the user's or a project's own settings can't shrink them. NOT run: nobody has checked it against the real program, so it is
 * marked untested and starts switched off.
 *
 * The guard lives in a per-run *system settings* file (QWEN_CODE_SYSTEM_SETTINGS_PATH), the same trick as
 * the hive's Gemini CLI engine (Qwen Code is a fork of it). The docs: "System settings override user and
 * project settings". QWEN_HOME is left alone, so the user's sign-in (OAuth tokens, the chosen auth type,
 * API keys in their own settings or .env) stays where it is and the hive never touches it.
 * - Every built-in tool is hidden ("tools.disabled": "Tool names hidden from the registry entirely",
 *   unioned across scopes) and denied ("permissions.deny": highest priority, and whole-tool denies remove
 *   built-ins from the registry; "MCP tools are exempt"). That covers shell, file edits and writes, web
 *   fetch and search, sub-agents, skills and memory; reading too, as in the Copilot preset (the hive's
 *   read_file guards secrets).
 * - Only the hive's MCP servers load (`--allowed-mcp-server-names`, which wins over every `mcp.allowed`),
 *   and only they are auto-approved (`permissions.allow: mcp__<server>`); never `trust: true`.
 * - `--approval-mode default` on every run, so the settings default `auto` (a model classifier) never
 *   applies. Anything else that would need approval fails in a headless run (per Qwen's headless guide).
 * - No hooks (`disableAllHooks`), no usage statistics, no telemetry.
 * - The servers' variables (the Brain's token among them) are in the settings file, written 0600 in the
 *   run folder; never on the command line. Values with "$" or "%NAME%" are refused: the Gemini CLI
 *   lineage expands them in settings.
 *
 * Still unknown (docs silent): the exact headless behaviour of a tool that needs approval in `default`
 * mode (a secondary source says it fails), how `permissions.deny` and `mcpServers` merge across scopes,
 * the token field names in `usage`, a headless sign-in check, and model names for a Qwen-account sign-in.
 * The per-run system settings file would also replace a machine-wide one an administrator set
 * (C:\ProgramData\qwen-code\settings.json), dropping their rules: the hive refuses to run Qwen Code there,
 * as it does for Gemini CLI with machine policies.
 */

export const QWEN_SETTINGS_FILE = 'qwen-system-settings.json';
/** A server name that matches nothing: with only this, no MCP server loads. */
export const QWEN_NO_SERVERS = 'hive-none';

/** Qwen Code's built-in tools by canonical name (the docs' alias table plus web search and memory). */
export const QWEN_BUILTIN_TOOLS = [
  'run_shell_command', 'edit', 'write_file', 'notebook_edit', 'read_file', 'read_many_files', 'grep_search', 'glob', 'list_directory',
  'web_fetch', 'web_search', 'task', 'skill', 'save_memory',
] as const;
/** The same, as permission rules (aliases and the docs' meta-categories: Read and Edit cover several tools). */
export const QWEN_DENY_RULES = ['Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'web_search', 'Agent', 'Skill', 'save_memory', 'read_many_files'] as const;

/** Qwen Code (Gemini CLI lineage) expands $VAR, ${VAR} and %VAR% in settings values. */
export const expandsInQwen = (v: string): boolean => /\$/.test(v) || /%\w+%/.test(v);

/** Qwen Code's machine-wide settings (Gemini CLI lineage; the Windows path is the one the docs name). */
export function qwenMachineSettings(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'C:\\ProgramData\\qwen-code\\settings.json';
  if (platform === 'darwin') return '/Library/Application Support/QwenCode/settings.json';
  return '/etc/qwen-code/settings.json';
}

/** The run's system settings and the flags that load exactly the given servers. */
export function qwenWiring(
  servers: HiveMcpServers,
  run: { runDir: string; platform: NodeJS.Platform },
  exists: (path: string) => boolean = existsSync,
): McpWiring {
  // The hive's settings take the system slot; an administrator's would be dropped, so refuse instead.
  const machine = qwenMachineSettings(run.platform);
  if (exists(machine)) {
    throw new Error(`This computer has machine-wide Qwen Code settings (${machine}) set by an administrator. The hive's guard would replace them, so it won't run Qwen Code here.`);
  }
  const names = Object.keys(servers) as HiveMcpName[];
  const mcpServers: Record<string, unknown> = {};
  for (const name of names) {
    const s = servers[name]!;
    const values: Array<[string, string]> = [
      ['command', s.command],
      ...s.args.map((a, i): [string, string] => [`argument ${i + 1}`, a]),
      ...Object.entries(s.env).map(([k, v]): [string, string] => [k, v]),
      ...(s.cwd ? [['cwd', s.cwd] as [string, string]] : []),
    ];
    const bad = values.find(([, v]) => expandsInQwen(v));
    if (bad) throw new Error(`The ${name} server's ${bad[0]} contains "$" or "%NAME%", which Qwen Code would expand. Refusing to run.`);
    mcpServers[name] = { command: s.command, args: s.args, env: s.env, ...(s.cwd ? { cwd: s.cwd } : {}), trust: false };
  }
  const settings = {
    tools: { approvalMode: 'default', disabled: [...QWEN_BUILTIN_TOOLS] },
    permissions: { deny: [...QWEN_DENY_RULES], allow: names.map((n) => `mcp__${n}`) },
    mcp: { allowed: names.length ? names : [QWEN_NO_SERVERS] },
    mcpServers,
    disableAllHooks: true,
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false, logPrompts: false },
  };
  const path = run.platform === 'win32' ? win32 : posix;
  return {
    args: ['--allowed-mcp-server-names', ...(names.length ? names : [QWEN_NO_SERVERS])],
    env: {
      QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(run.runDir, QWEN_SETTINGS_FILE),
      QWEN_USAGE_STATISTICS_ENABLED: 'false',
      QWEN_TELEMETRY_ENABLED: 'false',
    },
    files: [{ path: QWEN_SETTINGS_FILE, content: JSON.stringify(settings, null, 2) }],
  };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const AUTH = /\b401\b|unauthori[sz]ed|not authenticated|authentication (?:failed|required)|invalid api key|\/auth\b/i;
const QUOTA = /\b429\b|rate.?limit|quota|too many requests|usage limit/i;

/**
 * One line of `--output-format stream-json`, from the documented shapes only: `assistant` messages with
 * text blocks and the model, and the `result` (subtype, is_error, result, session_id). Token counts are
 * left out: the docs show `usage` only as "{...}".
 */
export function parseQwenLine(line: string): CommandEvent[] {
  let m: Json | null;
  try {
    m = obj(JSON.parse(line));
  } catch {
    return [];
  }
  if (!m) return [];
  switch (m['type']) {
    case 'assistant': {
      const msg = obj(m['message']);
      if (!msg) return [];
      const out: CommandEvent[] = [];
      const model = str(msg['model']);
      if (model) out.push({ kind: 'usage', usage: {}, model });
      const content = Array.isArray(msg['content']) ? msg['content'] : [];
      for (const b of content) {
        const block = obj(b);
        if (block?.['type'] === 'text' && str(block['text'])) out.push({ kind: 'text', text: str(block['text'])! });
      }
      return out;
    }
    case 'result': {
      const sessionId = str(m['session_id']);
      const text = str(m['result']);
      const ok = m['is_error'] !== true && m['subtype'] === 'success';
      if (ok) return [{ kind: 'final', ok: true, ...(text ? { text } : {}), ...(sessionId ? { sessionId } : {}) }];
      const message = str(obj(m['error'])?.['message']) ?? str(m['error']) ?? text ?? `Qwen Code stopped (${str(m['subtype']) ?? 'error'}).`;
      return [
        { kind: 'error', message, ...(AUTH.test(message) ? { auth: true } : {}), ...(QUOTA.test(message) ? { quota: true } : {}) },
        { kind: 'final', ok: false, errorMessage: message, ...(sessionId ? { sessionId } : {}) },
      ];
    }
    default:
      return [];
  }
}

export const QWEN_PRESET: CommandPreset = {
  id: 'qwen',
  name: 'Qwen Code',
  vendor: 'Alibaba (Qwen)',
  executable: 'qwen',
  version: { args: ['--version'], pattern: /(\d+\.\d+\.\d+)/, minimum: '0.26.5' },
  install: { command: 'npm install -g @qwen-code/qwen-code@0.26.5', note: "Qwen's official package (Apache-2.0). Needs Node.js 22 or newer and a Qwen sign-in." },
  signIn: { command: 'qwen', note: 'Start Qwen Code in a terminal and type /auth: a Qwen account (Plus or Pro), a Coding Plan, or an API key. The hive never sees your login.' },
  privacyNote: 'Qwen Code sends your prompts and the code it reads to the model provider you signed in with (Alibaba for a Qwen account). The hive switches off its usage statistics and telemetry.',
  // Stdin (no length limit, never read as a flag); `-p` is added to it, as in the docs' `cat file | qwen -p "..."`.
  prompt: { via: 'stdin' },
  headlessArgs: ['-p', 'Do the task described above.', '--output-format', 'stream-json', '--approval-mode', 'default'],
  // No model flag: the sign-in's own default (model names for a Qwen-account sign-in aren't documented).
  model: null,
  maxTurnsFlag: '--max-session-turns',
  output: { format: 'jsonl', parse: parseQwenLine },
  guard: {
    // Its own tools are switched off by the per-run settings file, written on every run.
    disableBuiltinTools: [],
    wireMcp: (servers, run) => qwenWiring(servers, run),
    wireAlways: true,
  },
  forbiddenArgs: [
    '--yolo', '-y', 'yolo', 'auto', 'auto-edit', '--approval-mode=yolo', '--approval-mode=auto', '--approval-mode=auto-edit',
    '--allowed-tools', '--include-directories', '--safe-mode', '--bare', '--extensions', '-e', '--acp', '--continue', '--resume',
    '--prompt-interactive', '-i',
  ],
  reportsCost: false,
  // A Qwen account sign-in needs a Plus or Pro subscription (an API key is billed per token instead).
  subscription: true,
  authHint: AUTH,
  exitCodes: { 53: 'limit', 55: 'limit', 130: 'stopped' },
  // Safe mode's effect on the run's settings file isn't documented; the run sets its own settings path.
  scrubEnv: ['QWEN_CODE_SAFE_MODE', 'QWEN_CODE_SYSTEM_SETTINGS_PATH'],
  tested: false,
};
