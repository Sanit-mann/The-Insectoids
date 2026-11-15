import { dirname, join } from 'node:path';
import type { HiveMcpName } from '../opencode/config';
import type { CommandEvent, CommandPreset, HiveMcpServers, McpWiring } from './preset';

/**
 * OpenAI Codex CLI (Phase 4 B3), on the generic command engine. Every fact here was checked against Codex
 * 0.166.0 on 2026-11-15, offline: its custom model provider pointed at a local fake Responses API and a
 * one-tool MCP server, so no ChatGPT account was used and nothing was spent (docs/research/engine-clis.md).
 * The user has no ChatGPT plan to test with, so it is still marked untested and starts switched off.
 *
 * The guard, all of it in Codex's own switches:
 * - `--sandbox read-only` (enforced by the operating system) and `approval_policy="never"`: anything that
 *   would need approval is refused, not asked about.
 * - Its own tools switched off by feature: shell and unified exec, sub-agents, goals, image viewing, hooks,
 *   apps, plugins, browser and computer use, image generation; web search off. Checked: the model is then
 *   offered only MCP tools (and request_user_input), and a call to exec_command, shell or apply_patch comes
 *   back "unsupported call".
 * - Only the hive's MCP servers are approved (`default_tools_approval_mode`); the user's own config.toml and
 *   rules are not loaded (`--ignore-user-config`, `--ignore-rules`; sign-in still works), and
 *   `--strict-config` stops the run if any of these keys is unknown to the installed version.
 * - The servers' variables (the Brain's token among them) reach them through Codex's environment by name
 *   (`env_vars`), never on its command line, where other programs could read them.
 */

/** A TOML basic string (a JSON string is one: same escapes for quotes, backslashes and control characters). */
const TOML = (v: string): string => JSON.stringify(v);

/** Codex's MCP servers for one run, as `-c` overrides; their variables go into Codex's environment by name. */
export function codexMcpWiring(servers: HiveMcpServers): McpWiring {
  const args: string[] = [];
  const env: Record<string, string> = {};
  for (const name of Object.keys(servers) as HiveMcpName[]) {
    const s = servers[name]!;
    const key = `mcp_servers.${name}`;
    for (const [k, v] of Object.entries(s.env)) {
      // Two servers wanting different values under one name can't share Codex's environment: refuse.
      if (k in env && env[k] !== v) throw new Error(`Two hive servers need different values for ${k}; Codex can't pass both. Refusing to run.`);
      env[k] = v;
    }
    args.push(
      '-c', `${key}.command=${TOML(s.command)}`,
      '-c', `${key}.args=[${s.args.map(TOML).join(',')}]`,
      '-c', `${key}.env_vars=[${Object.keys(s.env).map(TOML).join(',')}]`,
      ...(s.cwd ? ['-c', `${key}.cwd=${TOML(s.cwd)}`] : []),
      '-c', `${key}.required=true`,
      '-c', `${key}.default_tools_approval_mode="approve"`,
    );
  }
  return { args, env };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const AUTH = /\b401\b|unauthori[sz]ed|not logged in|codex login|authentication/i;
const QUOTA = /\b429\b|rate.?limit|usage limit|quota|too many requests/i;

/** One line of `codex exec --json`. */
export function parseCodexLine(line: string): CommandEvent[] {
  let m: Json | null;
  try {
    m = obj(JSON.parse(line));
  } catch {
    return [];
  }
  if (!m) return [];
  const item = obj(m['item']);
  switch (m['type']) {
    case 'item.completed':
      if (item?.['type'] === 'agent_message' && str(item['text'])) return [{ kind: 'text', text: str(item['text'])! }];
      return [];
    case 'item.started': {
      // Tool calls: the hive's MCP tools, and anything else Codex reports doing (there should be none).
      const t = str(item?.['type']);
      if (t === 'mcp_tool_call') return [{ kind: 'tool', name: `${str(item!['server']) ?? 'mcp'}_${str(item!['tool']) ?? 'tool'}`, ...(str(item!['id']) ? { id: str(item!['id'])! } : {}), input: item!['arguments'] }];
      if (t === 'command_execution' || t === 'file_change' || t === 'web_search') return [{ kind: 'tool', name: t, ...(str(item!['id']) ? { id: str(item!['id'])! } : {}), input: item }];
      return [];
    }
    case 'turn.completed': {
      const u = obj(m['usage']) ?? {};
      // input_tokens already include the cached ones; the hive counts fresh input and cache separately.
      const cached = num(u['cached_input_tokens']);
      const written = num(u['cache_write_input_tokens']);
      return [
        { kind: 'usage', usage: { input: Math.max(0, num(u['input_tokens']) - cached - written), output: num(u['output_tokens']), cacheRead: cached, cacheWrite: written } },
        { kind: 'final', ok: true },
      ];
    }
    case 'turn.failed': {
      const message = str(obj(m['error'])?.['message']) ?? 'Codex stopped with an error.';
      return [
        { kind: 'error', message, ...(AUTH.test(message) ? { auth: true } : {}), ...(QUOTA.test(message) ? { quota: true } : {}) },
        { kind: 'final', ok: false, errorMessage: message },
      ];
    }
    case 'error': {
      // "Reconnecting... n/5" lines are retries, not the outcome (turn.failed says that).
      const message = str(m['message']) ?? '';
      return message && !/^Reconnecting\.\.\./.test(message) ? [{ kind: 'error', message, ...(AUTH.test(message) ? { auth: true } : {}), ...(QUOTA.test(message) ? { quota: true } : {}) }] : [];
    }
    default:
      return [];
  }
}

const TRIPLE: Record<string, string> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};

/** npm's `codex` launcher only starts the native program from its platform package: start that directly. */
export function codexNativeBinary(script: string, exists: (p: string) => boolean, platform: NodeJS.Platform, arch: string = process.arch): string | null {
  if (!/[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/i.test(script)) return null;
  const triple = TRIPLE[`${platform}-${arch}`];
  if (!triple) return null;
  const pkg = `codex-${platform}-${arch}`;
  const exe = platform === 'win32' ? 'codex.exe' : 'codex';
  const root = dirname(dirname(script));
  return [join(root, 'node_modules', '@openai', pkg, 'vendor', triple, 'bin', exe), join(root, '..', pkg, 'vendor', triple, 'bin', exe)].find((p) => exists(p)) ?? null;
}

const effort = (level: string): string => `model_reasoning_effort=${TOML(level)}`;

export const CODEX_PRESET: CommandPreset = {
  id: 'codex',
  name: 'Codex CLI',
  vendor: 'OpenAI',
  executable: 'codex',
  resolveScript: (script, exists, platform) => codexNativeBinary(script, exists, platform),
  version: { args: ['--version'], pattern: /codex-cli (\d+\.\d+\.\d+)/, minimum: '0.166.0' },
  install: { command: 'npm install -g @openai/codex@0.166.0', note: "OpenAI's official package (Apache-2.0). Needs a ChatGPT plan or an OpenAI API key." },
  signIn: { command: 'codex login', note: 'Sign in with your ChatGPT account. The hive never sees your login.' },
  privacyNote: 'Codex sends your prompts and the code it reads to OpenAI. The hive switches off its analytics.',
  // Stdin (no prompt argument): no command-line length limit, and the prompt can never be read as a flag.
  prompt: { via: 'stdin' },
  headlessArgs: ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--strict-config', '--color', 'never', '-c', 'analytics.enabled=false'],
  // No model flag: the account's own default model for every tier (no plan here to check model names with).
  model: null,
  effort: { flag: '-c', values: { low: effort('low'), medium: effort('medium'), high: effort('high') } },
  output: { format: 'jsonl', parse: parseCodexLine },
  signedInCheck: { args: ['login', 'status'], signedIn: /^Logged in/m },
  guard: {
    disableBuiltinTools: [
      '--sandbox', 'read-only', '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
      ...['shell_tool', 'unified_exec', 'multi_agent', 'goals', 'view_image', 'hooks', 'apps', 'plugins', 'browser_use', 'computer_use', 'image_generation'].flatMap((f) => ['--disable', f]),
    ],
    wireMcp: (servers) => codexMcpWiring(servers),
  },
  forbiddenArgs: [
    '--dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto', '--approve-for-me', '--dangerously-bypass-hook-trust',
    'danger-full-access', 'workspace-write', '--enable', '--add-dir', '--worktree', '--profile', '-p', '--cyber-access-program', '--oss',
  ],
  reportsCost: false,
  subscription: true,
  authHint: AUTH,
  tested: false,
};

/**
 * Cursor's agent CLI (Phase 4 B3): listed with its real install and sign-in, never run. It can't be guarded
 * here: its print mode edits workspace files on its own (even without --force), and its MCP servers can't
 * be given for one run (it reads the project's .cursor/mcp.json), so the hive tools can't replace its own.
 * It waits for container mode (docs/research/engine-clis.md).
 */
export const CURSOR_PRESET: CommandPreset = {
  id: 'cursor',
  name: 'Cursor agent CLI',
  vendor: 'Anysphere (Cursor)',
  executable: 'agent',
  version: { args: ['--version'], pattern: /(\d+\.\d+\.\d+)/, minimum: '0.0.0' },
  install: { command: "irm 'https://cursor.com/install?win32=true' | iex", note: "Cursor's official installer (PowerShell; it updates itself). Needs a Cursor plan." },
  signIn: { command: 'agent login', note: 'Sign in with your Cursor account. The hive never sees your login.' },
  privacyNote: 'Cursor sends your prompts and the code it reads to Cursor and its model providers.',
  prompt: { via: 'arg', flag: '-p' },
  headlessArgs: ['--output-format', 'stream-json'],
  model: null,
  output: { format: 'text' },
  signedInCheck: { args: ['status'], signedIn: /logged in|signed in/i },
  guard: null,
  unguardedWhy: 'Its headless mode edits files on its own, and its tools can’t be set for one run.',
  forbiddenArgs: ['--force', '-f', '--yolo', '--approve-mcps', '--trust'],
  reportsCost: false,
  subscription: true,
  tested: false,
};
