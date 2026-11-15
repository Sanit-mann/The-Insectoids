import { dirname, join } from 'node:path';
import type { Usage } from '../claude/stream';
import type { HiveMcpName } from '../opencode/config';
import type { CommandEvent, CommandPreset, HiveMcpServers } from './preset';

/**
 * GitHub Copilot CLI (Phase 4 B2), on the generic command engine. Every fact here was checked against
 * Copilot CLI 1.0.105 on 2026-11-15, first offline (its documented BYOK mode pointed at a local fake model
 * and a one-tool MCP server: no account, nothing spent), then with one real, signed-in run the user
 * approved: Auto (efficiency) answered on gpt-6-luna for 1 premium request (docs/research/engine-clis.md).
 *
 * The guard, all of it in Copilot's own flags:
 * - `--available-tools` decides which tools the model sees at all. A run always passes a name that matches
 *   nothing (so a run with no MCP servers sees no tools), then the exact names of the hive's MCP tools.
 *   Checked: Copilot's own powershell / view / create / edit tools then "do not exist" for the model.
 * - Deny rules for shell, file writes and URLs, which win over every allow rule (belt and braces).
 * - Headless (prompt on stdin), a tool that isn't approved is refused; only the hive's servers are approved.
 * - Its GitHub MCP server is off (it could act on GitHub), auto-update is off (the hive runs the version
 *   the user installed), and COPILOT_ALLOW_ALL never reaches it ("true" also trusts the folder and runs
 *   its hooks).
 */

/** The hive's MCP tools by server, as registered in packages/{hive-tools,brain,services}-mcp. */
export const HIVE_MCP_TOOLS: Readonly<Record<HiveMcpName, readonly string[]>> = {
  hive: ['read_file', 'list_dir', 'glob', 'search', 'write_file', 'edit_file', 'run_shell'],
  brain: ['brain_boot_card', 'brain_read', 'brain_code', 'brain_search', 'brain_get', 'brain_history', 'brain_links', 'brain_write', 'brain_update', 'brain_archive', 'brain_link'],
  services: ['call_service'],
};

/** Copilot names an MCP tool "<server>-<tool>". */
export const copilotToolName = (server: string, tool: string): string => `${server}-${tool}`;

/** A tool name that matches nothing: with only this, the model sees no tools at all. */
export const NO_TOOLS = 'hive-none';

const MCP_FILE = 'copilot-mcp.json';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const AUTH = /auth|login|token|credential|unauthori[sz]ed|401/i;
const QUOTA = /quota|rate.?limit|too many requests|429|ai credits|premium requests|limit (?:was )?reached/i;

/** One line of `--output-format json`. Copilot sends many event kinds; the hive reads these. */
export function parseCopilotLine(line: string): CommandEvent[] {
  let m: Json | null;
  try {
    m = obj(JSON.parse(line));
  } catch {
    return [];
  }
  if (!m) return [];
  const data = obj(m['data']) ?? {};
  switch (m['type']) {
    case 'assistant.message': {
      // Whole messages (not the deltas, which would repeat them); a message that only calls tools is empty.
      const text = str(data['content']);
      return text ? [{ kind: 'text', text }] : [];
    }
    case 'tool.execution_start':
      return [{ kind: 'tool', name: str(data['toolName']) ?? 'tool', ...(str(data['toolCallId']) ? { id: str(data['toolCallId'])! } : {}), input: data['arguments'] }];
    case 'session.error': {
      const message = str(data['message']) ?? 'Copilot reported an error.';
      const kind = `${str(data['errorType']) ?? ''} ${message}`;
      return [{ kind: 'error', message, ...(AUTH.test(kind) ? { auth: true } : {}), ...(QUOTA.test(kind) ? { quota: true } : {}) }];
    }
    case 'result':
      // The process may still exit 0 after a failed session: this exit code is the one that counts.
      return [{ kind: 'final', ok: m['exitCode'] === 0, ...(str(m['sessionId']) ? { sessionId: str(m['sessionId'])! } : {}) }];
    default:
      return [];
  }
}

/** `--usage-output-file`: token counts per model (Copilot puts none in its event stream). */
export function parseCopilotUsage(json: unknown): { usage: Partial<Usage>; models: string[] } | null {
  const metrics = obj(obj(json)?.['modelMetrics']);
  if (!metrics) return null;
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const models: string[] = [];
  for (const [model, v] of Object.entries(metrics)) {
    const u = obj(obj(v)?.['usage']);
    if (!u) continue;
    models.push(model);
    // Copilot's inputTokens already include the cached ones (a real run: 2,965 input, 2,962 of them cache
    // writes); the hive counts fresh input and cache separately, as Claude Code reports them.
    const read = num(u['cacheReadTokens']);
    const write = num(u['cacheWriteTokens']);
    usage.input += Math.max(0, num(u['inputTokens']) - read - write);
    usage.output += num(u['outputTokens']);
    usage.cacheRead += read;
    usage.cacheWrite += write;
  }
  return models.length ? { usage, models } : null;
}

/** The hive's MCP servers as Copilot's MCP config, plus the exact tool allowlist and approvals for them. */
export function copilotMcpWiring(servers: HiveMcpServers, run: { runDir: string; platform: NodeJS.Platform }) {
  const names = Object.keys(servers) as HiveMcpName[];
  const mcpServers: Record<string, unknown> = {};
  for (const name of names) {
    const s = servers[name]!;
    mcpServers[name] = { type: 'local', command: s.command, args: s.args, env: s.env, ...(s.cwd ? { cwd: s.cwd } : {}), tools: ['*'] };
  }
  const tools = names.flatMap((n) => HIVE_MCP_TOOLS[n].map((t) => copilotToolName(n, t)));
  const sep = run.platform === 'win32' ? '\\' : '/';
  return {
    args: [
      // "@" reads the file; the run folder is outside every workspace.
      `--additional-mcp-config=@${run.runDir}${sep}${MCP_FILE}`,
      `--available-tools=${tools.join(',')}`,
      ...names.map((n) => `--allow-tool=${n}`),
    ],
    files: [{ path: MCP_FILE, content: JSON.stringify({ mcpServers }, null, 2) }],
  };
}

/** npm's `copilot` launcher only starts a native program from its platform package: start that directly. */
export function copilotNativeBinary(script: string, exists: (p: string) => boolean, platform: NodeJS.Platform, arch: string = process.arch): string | null {
  if (!/[\\/]@github[\\/]copilot[\\/]npm-loader\.js$/i.test(script)) return null;
  const pkg = `copilot-${platform}-${arch}`;
  const exe = platform === 'win32' ? 'copilot.exe' : 'copilot';
  const dir = dirname(script);
  return [join(dir, 'node_modules', '@github', pkg, exe), join(dir, '..', pkg, exe)].find((p) => exists(p)) ?? null;
}

/** Tier names: "auto:<profile>" lets Copilot pick the model within its Auto routing profile. */
export function copilotModelArgs(model: string): string[] {
  const auto = /^auto:(\w+)$/.exec(model);
  return auto ? ['--model=auto', `--auto-tier=${auto[1]}`] : [`--model=${model}`];
}

export const COPILOT_PRESET: CommandPreset = {
  id: 'copilot',
  name: 'GitHub Copilot CLI',
  vendor: 'GitHub',
  executable: 'copilot',
  // VS Code puts a `copilot` stand-in on PATH that isn't the CLI (it offers to install it).
  ignorePaths: /[\\/]copilot-shim[\\/]/i,
  resolveScript: (script, exists, platform) => copilotNativeBinary(script, exists, platform),
  version: { args: ['--version'], pattern: /Copilot CLI (\d+\.\d+\.\d+)/, minimum: '1.0.105' },
  install: { command: 'npm install -g @github/copilot@1.0.105', note: "GitHub's official package (its own licence terms). Needs a GitHub Copilot plan." },
  signIn: { command: 'copilot login', note: 'Opens your browser to sign in to GitHub. The hive never sees your login.' },
  privacyNote: 'Copilot sends your prompts and the code it reads to GitHub. The hive switches off the CLI’s own telemetry; GitHub still records usage on its side.',
  // Stdin: no command-line length limit, and the prompt can never be read as a flag.
  prompt: { via: 'stdin' },
  headlessArgs: ['--output-format=json', '--no-auto-update', '--disable-client-telemetry', '--no-ask-user', '--disable-builtin-mcps', '--disallow-temp-dir', '--no-color'],
  model: { flag: '--model', tiers: { strongest: 'auto:intelligence', standard: 'auto:balance', light: 'auto:efficiency' }, args: copilotModelArgs },
  // Checked on a real run: Auto refuses an effort level ("does not support reasoning effort configuration").
  effort: { flag: '--reasoning-effort', values: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }, skipFor: (m) => m === 'auto' || m.startsWith('auto:') },
  usageFile: { flag: '--usage-output-file', parse: parseCopilotUsage },
  output: { format: 'jsonl', parse: parseCopilotLine },
  guard: {
    disableBuiltinTools: [`--available-tools=${NO_TOOLS}`, '--deny-tool=shell', '--deny-tool=write', '--deny-tool=url'],
    wireMcp: copilotMcpWiring,
  },
  forbiddenArgs: [
    '--allow-all-tools', '--allow-all', '--yolo', '--allow-all-paths', '--allow-all-urls', '--trust-folder',
    '--autopilot', '--mode', '--plan', '--fleet', '--assisted-approval', '--enable-all-github-mcp-tools',
    '--add-github-mcp-toolset', '--add-github-mcp-tool', '--allow-all-mcp-server-instructions', '--mcp-github-auth',
    '--enable-mcp-server', '--add-dir', '--plugin-dir', '--share', '--share-gist', '--enable-memory', '--acp',
    '--connect', '--host-environment',
  ],
  reportsCost: false,
  subscription: true,
  authHint: /could not be validated|bad credentials|no authentication|not authenticated|not logged in|\/login|copilot login/i,
  scrubEnv: ['COPILOT_ALLOW_ALL', 'COPILOT_ASSISTED_APPROVAL'],
  // Checked by a person on 2026-11-15: one real, signed-in run of 1.0.105 through the hive's engine.
  tested: true,
};
