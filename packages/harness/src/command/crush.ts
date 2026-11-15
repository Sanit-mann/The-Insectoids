import type { CommandPreset } from './preset';

/**
 * Crush (`crush`, Charm; Phase 4 B4): listed with its real install and sign-in, never run. Checked from the
 * docs and source only, on 2026-11-15, NOT run (no `crush` on this PC): github.com/charmbracelet/crush
 * (README, internal/cmd/root.go, internal/cmd/run.go, internal/app/app.go), next-docs.charm.land/crush, npm
 * `@charmland/crush` 0.101.0 docs; install pinned to 0.99.0 by the 14-day rule (docs/research/engine-clis.md, section 7).
 *
 * Why it can't be guarded yet:
 * - `crush run` approves every permission request of its session by itself (app.go: RunNonInteractive calls
 *   AutoApproveSession), so a tool it can see is a tool it uses without asking.
 * - The only guard is hiding tools with `permissions deny` in a crushrc, and a repository's own .crushrc /
 *   crushrc is read before the global one (whether it can undo the hive's denies isn't documented).
 * - It has no JSON output and reports no tokens.
 * It waits for container mode.
 *
 * Unknown in the docs: the full list of its tool names, exit-code numbers, a sign-in status command.
 */
export const CRUSH_PRESET: CommandPreset = {
  id: 'crush',
  name: 'Crush',
  vendor: 'Charm',
  executable: 'crush',
  // Printed by its CLI library as "crush version v0.101.0" (the "v" is optional here).
  version: { args: ['--version'], pattern: /version v?(\d+\.\d+\.\d+)/, minimum: '0.99.0' },
  install: { command: 'npm install -g @charmland/crush@0.99.0', note: "Charm's official package (FSL-1.1-MIT, source-available). Needs an account or API key with a model provider it supports." },
  signIn: { command: 'crush login', note: 'Sign in with Crush itself (or set up a provider in its own setup). The hive never sees your login.' },
  privacyNote: 'Crush sends your prompts and the code it reads to the model provider you set up. It also sends usage metrics to Charm unless CRUSH_DISABLE_METRICS=1 is set.',
  // "Can be provided as arguments or piped from stdin": stdin has no length limit and never reads as a flag.
  prompt: { via: 'stdin' },
  headlessArgs: ['run', '--quiet'],
  // Model names depend on the provider the user set up (`crush models` lists them): its default for every tier.
  model: null,
  effort: { flag: '--reasoning-effort', values: { low: 'low', medium: 'medium', high: 'high' } },
  output: { format: 'text' },
  guard: null,
  unguardedWhy: 'Its headless mode approves every tool call by itself, and a repository’s own Crush settings are read before any the hive could give it.',
  // --yolo is a count flag (-y, -yy: the second also allows dangerous commands); --host runs on another Crush server.
  forbiddenArgs: ['--yolo', '-y', '-yy', '-yyy', '--host', '-H'],
  reportsCost: false,
  subscription: false,
  tested: false,
};
