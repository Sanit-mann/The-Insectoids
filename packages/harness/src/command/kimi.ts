import type { CommandPreset } from './preset';

/**
 * Kimi Code CLI (Phase 4 B4): listed with its real install and sign-in, never run. Written from Moonshot's
 * docs on 2026-11-15 (moonshotai.github.io/kimi-code: the kimi command, config files, config overrides,
 * environment variables, data locations; docs for npm 2.6.2, install pinned to 2.4.1 by the 14-day rule) and docs/research/engine-clis.md §6. NOT run.
 * (The older Python "Kimi CLI" is archived; this is its successor, `@moonshot-ai/kimi-code`.)
 *
 * Why it can't be guarded here:
 * - `kimi -p` handles every tool call under the `auto` permission policy ("no human approval is
 *   requested"), and its own tools can only be switched off in config.toml (`[tools] enabled/disabled`).
 * - The only documented way to give one run its own config.toml and mcp.json is to move the whole data
 *   folder with KIMI_CODE_HOME. Its sign-in moves with it (OAuth tokens live in `credentials/` under that
 *   folder), so a per-run folder would sign the user out, and the hive never copies or handles credentials.
 * - No flag or variable points at another config or MCP file, and the user's own config has no per-run
 *   override for tools, permission rules or MCP servers.
 * It waits for container mode.
 *
 * Its stream-json events aren't documented (only "Assistant" and "Tool" messages are named), so the preset
 * reads plain text. No headless sign-in check is documented either.
 */
export const KIMI_PRESET: CommandPreset = {
  id: 'kimi',
  name: 'Kimi Code CLI',
  vendor: 'Moonshot AI',
  executable: 'kimi',
  version: { args: ['--version'], pattern: /(\d+\.\d+\.\d+)/, minimum: '2.4.1' },
  install: { command: 'npm install -g @moonshot-ai/kimi-code@2.4.1', note: "Moonshot's official package (MIT). Needs a Kimi membership that includes Kimi Code, or a Moonshot API key." },
  signIn: { command: 'kimi login', note: 'Signs in to Kimi Code with a device code in your browser. The hive never sees your login.' },
  privacyNote: 'Kimi Code sends your prompts and the code it reads to Moonshot AI. Its telemetry is on unless switched off.',
  // Stdin input isn't documented; the prompt goes after -p.
  prompt: { via: 'arg', flag: '-p' },
  headlessArgs: ['--output-format', 'text'],
  model: null,
  output: { format: 'text' },
  guard: null,
  unguardedWhy:
    'Its own tools can only be switched off in its config folder, and giving one run its own config folder (KIMI_CODE_HOME) would also move its sign-in, which the hive never copies.',
  forbiddenArgs: [
    '--yolo', '-y', '--yes', '--auto-approve', '--auto', '--agent', '--agent-file', '--skills-dir', '--add-dir',
    '--session', '-S', '--resume', '-r', '--continue', '-c', '--environment', '--environment-cwd', '--dangerous-bypass-auth',
  ],
  reportsCost: false,
  // Kimi Code comes with a Kimi membership (an Open Platform API key is billed per token instead).
  subscription: true,
  scrubEnv: ['KIMI_CODE_DANGEROUS_COMMAND_GUARD', 'KIMI_CODE_TRUST_WORKSPACE', 'KIMI_CODE_EXPERIMENTAL_FLAG', 'KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT'],
  tested: false,
};
