import type { CommandPreset } from './preset';

/**
 * Grok Build (`grok`, xAI's official coding CLI; Phase 4 B4): listed with its real install and sign-in, never
 * run. Checked from the docs only, on 2026-11-15, NOT run (no `grok` on this PC): docs.x.ai/build/overview,
 * /build/cli/headless-scripting, /build/settings/reference, /build/modes-and-commands, xAI's Grok Build
 * announcement, github.com/xai-org/grok-build (docs/research/engine-clis.md, section 5).
 *
 * Why it can't be guarded yet:
 * - Its tool rules (`[permission]` deny rules, `[features] write_file = false`) and MCP servers live in
 *   config.toml under GROK_HOME. There is no flag or variable for a config file of one run; the only per-run
 *   choice is a separate GROK_HOME, and that folder also holds the sign-in, so a fresh one is signed out. The
 *   hive never copies or reads credentials, and an API key would be a secret it handles.
 * - It has no switch that turns its bash tool off (only deny rules, not checked), and the docs don't say what
 *   a headless run does with a tool call that needs approval when --always-approve isn't given.
 * - A repository's own .grok/config.toml can add MCP servers and permission rules, and Grok also loads the
 *   MCP servers in Claude's and Cursor's configs unless told not to.
 * It waits for container mode.
 *
 * Unknown in the docs: a version flag and its output (`--version` assumed), the streaming-json event schema
 * (so plain text output here), token and cost reporting, exit codes, a sign-in status command, telemetry.
 */
export const GROK_PRESET: CommandPreset = {
  id: 'grok',
  name: 'Grok Build',
  vendor: 'xAI',
  executable: 'grok',
  // Not documented: `--version` is the usual convention; no released version is listed yet.
  version: { args: ['--version'], pattern: /(\d+\.\d+\.\d+)/, minimum: '0.0.0' },
  install: { command: 'irm https://x.ai/cli/install.ps1 | iex', note: "xAI's official installer (PowerShell; Apache-2.0). Needs a SuperGrok or X Premium+ plan, or an xAI API key." },
  signIn: { command: 'grok', note: 'Its first start opens your browser to sign in to xAI. The hive never sees your login.' },
  privacyNote: 'Grok Build sends your prompts and the code it reads to xAI. Its /privacy command shows and changes its data-retention setting.',
  prompt: { via: 'arg', flag: '-p' },
  headlessArgs: ['--output-format', 'plain', '--no-alt-screen', '--no-auto-update'],
  // Which models a plan includes isn't documented: the account's default model for every tier.
  model: null,
  output: { format: 'text' },
  guard: null,
  unguardedWhy: 'Switching off its own tools for one run needs a separate Grok home folder, which also holds your sign-in, and it has no switch that turns off its shell tool.',
  forbiddenArgs: ['--always-approve'],
  reportsCost: false,
  subscription: true,
  // Would make its sandbox approve every shell command.
  scrubEnv: ['GROK_SANDBOX_AUTO_ALLOW_BASH'],
  tested: false,
};
