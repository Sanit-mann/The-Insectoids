/** Effort levels Claude Code accepts with --effort (availability depends on the model). */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClaudeArgsInput {
  /** Settings for this run only (our guard hook); merged over project settings by Claude Code. */
  settings: object;
  model?: string;
  effort?: Effort;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** The card's brief and rules, appended to Claude Code's own system prompt. */
  systemPromptFile?: string;
  /** MCP servers for this insect only (e.g. the Brain door). */
  mcpConfig?: string;
}

/**
 * Headless command line for one card. The prompt itself goes in on stdin (no length or quoting limits).
 * - dontAsk: nothing prompts; tools run only when the guard hook allows them.
 * - setting-sources project,local: the user's personal hooks and plugins don't leak into insects.
 * - no-session-persistence: insects leave no resumable sessions behind; the Brain keeps the handoff.
 */
export function buildClaudeArgs(o: ClaudeArgsInput): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'dontAsk',
    '--setting-sources', 'project,local',
    '--no-session-persistence',
    '--settings', JSON.stringify(o.settings),
  ];
  if (o.model) args.push('--model', o.model);
  if (o.effort) args.push('--effort', o.effort);
  if (o.maxTurns !== undefined) args.push('--max-turns', String(o.maxTurns));
  if (o.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(o.maxBudgetUsd));
  if (o.systemPromptFile) args.push('--append-system-prompt-file', o.systemPromptFile);
  if (o.mcpConfig) args.push('--mcp-config', o.mcpConfig, '--strict-mcp-config');
  return args;
}

/**
 * Registers the command guard before every tool. A hook that fails (crash, timeout) must block,
 * because Claude Code otherwise lets the tool run after a non-blocking hook error.
 */
export function buildHookSettings(hook: { command: string; args: string[] }): object {
  return {
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hook.command, args: hook.args, timeout: 30, onFailure: 'block' }] }],
    },
  };
}
