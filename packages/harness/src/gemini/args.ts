import type { Effort } from '../claude/args';

/** One MCP server for a run, in Gemini CLI's settings shape. */
export interface GeminiMcpServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Milliseconds; Gemini's default is generous, the hive keeps tool calls bounded. */
  timeout?: number;
}

/** The MCP servers a hive run may use. Everything else (the user's own servers) stays off. */
export const HIVE_MCP_SERVERS = ['hive', 'brain'] as const;

/**
 * Gemini 3 models take a thinking level (only LOW and HIGH exist in 0.68.0); Gemini 2.5 models take a
 * token budget. Overrides match the built-in alias families, so whichever model the alias resolves
 * to gets the right kind of setting.
 */
export function geminiThinkingOverrides(effort: Effort): Array<{ match: { model: string }; modelConfig: unknown }> {
  const level = effort === 'low' || effort === 'medium' ? 'LOW' : 'HIGH';
  const budget = { low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 24576 }[effort];
  return [
    { match: { model: 'chat-base-3' }, modelConfig: { generateContentConfig: { thinkingConfig: { thinkingLevel: level } } } },
    { match: { model: 'chat-base-2.5' }, modelConfig: { generateContentConfig: { thinkingConfig: { thinkingBudget: budget } } } },
  ];
}

export interface GeminiSettingsInput {
  mcpServers: Record<string, GeminiMcpServer>;
  maxTurns?: number;
  effort?: Effort;
  /** A context file name that no project or user folder has, so their GEMINI.md never loads. */
  contextFileName: string;
}

/**
 * The run's system settings (GEMINI_CLI_SYSTEM_SETTINGS_PATH). System settings merge last, so these win
 * over the user's own: no hooks at all (the user's hooks don't run inside hive work; the hive's guard is
 * in the policy and the hive tools instead), no usage statistics, never spend AI credits.
 */
export function buildGeminiSettings(o: GeminiSettingsInput): Record<string, unknown> {
  return {
    mcpServers: o.mcpServers,
    model: { ...(o.maxTurns ? { maxSessionTurns: o.maxTurns } : {}) },
    ...(o.effort ? { modelConfigs: { customOverrides: geminiThinkingOverrides(o.effort) } } : {}),
    // Hive runs never update Gemini CLI behind the user's back (an interactive run updated 0.66.0 → 0.68.0 itself).
    general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
    privacy: { usageStatisticsEnabled: false },
    billing: { overageStrategy: 'never' },
    context: { fileName: o.contextFileName },
    hooksConfig: { enabled: false },
  };
}

/**
 * The run's admin policy (`--admin-policy`, the highest tier). Admin rules outrank every user and default
 * rule. It is a static rule set, so unlike a hook it can't fail open.
 * - Normal runs: every built-in tool is denied (shell, file edits, web); only the hive's MCP servers are
 *   allowed. Changes go through the hive tools, which run the command guard before acting.
 * - Read-only runs (the hive tools are missing): the built-in read tools only, inside the workspace,
 *   with obvious secret files denied, plus the Brain.
 */
export function buildGeminiPolicy(o: { readOnly: boolean }): string {
  const rule = (lines: string[]): string => ['[[rule]]', ...lines].join('\n');
  const rules = [
    rule([
      'toolName = "*"',
      'decision = "deny"',
      'priority = 100',
      `denyMessage = "${o.readOnly ? 'This hive run is read-only.' : "Use the hive's tools (mcp_hive_*) for files and commands; built-in tools are switched off in the hive."}"`,
    ]),
    rule(['toolName = "*"', 'mcpName = "brain"', 'decision = "allow"', 'priority = 900']),
  ];
  if (o.readOnly) {
    rules.push(
      rule(['toolName = ["read_file", "read_many_files", "list_directory", "glob", "grep_search"]', 'decision = "allow"', 'priority = 800']),
      rule([
        'toolName = ["read_file", "read_many_files", "list_directory", "glob", "grep_search"]',
        // Secrets the command guard also protects: .env files, keys, cloud and SSH credentials.
        String.raw`argsPattern = '(\.env|id_rsa|id_ed25519|\.pem|\.key|credentials|\.ssh|\.aws|\.gnupg|\.npmrc)'`,
        'decision = "deny"',
        'priority = 850',
        'denyMessage = "Protected file: the hive never reads secrets."',
      ]),
    );
  } else {
    rules.push(rule(['toolName = "*"', 'mcpName = "hive"', 'decision = "allow"', 'priority = 900']));
  }
  return `# The Insectoids: per-run admin policy for Gemini CLI. Generated; deleted after the run.\n\n${rules.join('\n\n')}\n`;
}

export interface GeminiArgsInput {
  model?: string;
  policyFile: string;
  readOnly: boolean;
}

/**
 * Headless, stream-json, the hive's policy, only the hive's MCP servers, no extensions, and the card's
 * workspace trusted for this session only. The prompt itself arrives on stdin (`-p` is appended to it).
 */
export function buildGeminiArgs(o: GeminiArgsInput): string[] {
  return [
    '-p', 'Do the task described above.',
    '-o', 'stream-json',
    ...(o.model ? ['-m', o.model] : []),
    '--approval-mode', o.readOnly ? 'plan' : 'default',
    '--admin-policy', o.policyFile,
    '--allowed-mcp-server-names', ...HIVE_MCP_SERVERS,
    '-e', 'none',
    '--skip-trust',
  ];
}
