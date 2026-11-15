import { existsSync } from 'node:fs';
import type { Effort } from '../claude/args';
import type { EngineAdapter, EngineCapabilities, EngineDetection } from '../engines/registry';
import type { Engine } from '../hive/engine';
import { type CommandInstall, checkCommandSignIn, detectCommand } from './detect';
import { CommandEngine } from './engine';
import { type CommandPreset, unguardedReason } from './preset';
import type { runCommand } from './run';

export interface CommandAdapterOptions {
  /** The hive tools MCP bundle; null or a missing file = read-only work only. */
  hiveTools: string | null;
  /** Runtime for the hive's MCP servers in these runs. */
  runtime: { command: string; args?: string[]; env?: Record<string, string> };
  /** Per-run folders go here (outside every workspace). */
  runBase: string;
  /** Tests: replace detection, the sign-in check, the runner and the file check. */
  detect?: () => Promise<CommandInstall>;
  signedIn?: (install: { command: string; args: string[] }) => Promise<boolean | null>;
  run?: typeof runCommand;
  exists?: (path: string) => boolean;
}

/** Shown on an engine whose preset can't be guarded: the plan for it, not a promise of a date. */
export const CONTAINER_MODE = 'container mode (Phase 4 · step D1)';

const UNTESTED = ' This preset hasn’t been checked against the real program by a person yet.';

/**
 * An engine from a preset on the generic command engine. Guarded presets are detected and run like the
 * other engines; an unguarded one is listed only, with the reason, and never detected, routed or run.
 */
export function commandAdapter(preset: CommandPreset, o: CommandAdapterOptions): EngineAdapter {
  const exists = o.exists ?? existsSync;
  const effort = preset.effort ? (Object.keys(preset.effort.values) as Effort[]) : null;
  const base = {
    id: preset.id,
    name: preset.name,
    vendor: preset.vendor,
    models: preset.model?.tiers ?? { strongest: 'default', standard: 'default', light: 'default' },
    install: preset.install,
    signIn: preset.signIn,
    privacyNote: preset.privacyNote,
  };
  const why = unguardedReason(preset);
  if (why) {
    return {
      ...base,
      capabilities: { guard: null, mcp: Boolean(preset.guard?.wireMcp), effort, reportsCost: preset.reportsCost, free: false },
      availableIn: CONTAINER_MODE,
      unavailableReason: why,
    };
  }

  const canWire = Boolean(preset.guard?.wireMcp);
  const hasTools = (): boolean => Boolean(o.hiveTools && exists(o.hiveTools));
  let install: Extract<CommandInstall, { status: 'installed' }> | null = null;
  let engine: { key: string; engine: Engine } | null = null;
  const name = preset.name;
  return {
    ...base,
    get capabilities(): EngineCapabilities {
      return { guard: canWire && hasTools() ? 'policy-and-tools' : 'read-only', mcp: canWire, effort, reportsCost: preset.reportsCost, free: false };
    },
    availableIn: null,
    async detect(): Promise<EngineDetection> {
      install = null;
      const found = await (o.detect ?? (() => detectCommand(preset)))();
      const how = preset.install ? ' Install it with the command below; the hive checks again every minute.' : ' The hive checks again every minute.';
      if (found.status === 'missing') return { state: 'missing', version: null, message: `${name} is not installed.${how}` };
      if (found.status === 'unsupported') return { state: 'missing', version: null, message: found.reason };
      if (found.status === 'outdated') {
        return { state: 'outdated', version: found.version, message: `${name} ${found.version} is older than ${found.minimum}, the oldest the hive runs. Update it.` };
      }
      const signedIn = await (o.signedIn ?? ((i) => checkCommandSignIn(preset, i)))({ command: found.command, args: found.args });
      if (signedIn === false) {
        const cmd = preset.signIn ? ` Run "${preset.signIn.command}" in a terminal;` : ' Sign in with its own login;';
        return { state: 'signed-out', version: found.version, message: `${name} is signed out.${cmd} the hive checks again every minute.` };
      }
      install = found;
      const tools = canWire ? (hasTools() ? '' : ', for read-only work only: the hive tools aren’t built (run "pnpm build:doors")') : ', for read-only work only: it can’t load the hive’s guarded tools';
      const unsure = signedIn === null ? ' The hive can’t check its sign-in; a signed-out run will say so.' : '';
      return { state: 'ready', version: found.version, message: `${name} ${found.version} is ready${tools}.${unsure}${preset.tested ? '' : UNTESTED}` };
    },
    create(): Engine {
      if (!install) throw new Error(`${name} is not ready.`);
      const tools = canWire && hasTools() ? o.hiveTools : null;
      const key = `${install.command}|${install.args.join(' ')}|${tools ?? ''}`;
      if (engine?.key !== key) {
        engine = {
          key,
          engine: new CommandEngine({
            preset,
            bin: { command: install.command, args: install.args },
            hiveTools: tools,
            runtime: o.runtime,
            runBase: o.runBase,
            ...(o.run ? { run: o.run } : {}),
          }),
        };
      }
      return engine.engine;
    },
  };
}
