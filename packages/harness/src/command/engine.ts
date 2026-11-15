import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { HookPolicy } from '@insectoids/reflexes';
import { brainEnv } from '../hive/brain-access';
import type { Engine, EngineRequest, EngineRun } from '../hive/engine';
import { isReadOnlyRole } from '../hive/router';
import { servicesEnv } from '../hive/services-access';
import type { CommandPreset, HiveMcpServers } from './preset';
import { refuseRun, runCommand } from './run';

export interface CommandEngineOptions {
  preset: CommandPreset;
  /** The resolved program (from detection): never a .cmd launcher, never a shell. */
  bin: { command: string; args: string[] };
  /** The hive tools MCP bundle; null = not built, so only read-only work. */
  hiveTools: string | null;
  /** Runtime for the hive's MCP servers (the app's own executable as Node: its env goes only to them). */
  runtime: { command: string; args?: string[]; env?: Record<string, string> };
  /** Per-run folders go here (outside every workspace). */
  runBase: string;
  /** Tests: a stand-in for runCommand. */
  run?: typeof runCommand;
}

/** The hive's runs on a preset's CLI (Phase 4 B1). */
export class CommandEngine implements Engine {
  #n = 0;

  constructor(private readonly o: CommandEngineOptions) {}

  run(req: EngineRequest): EngineRun {
    const p = this.o.preset;
    // The router never sends work to an unguarded preset; refusing here keeps the rule if anything else does.
    if (!p.guard) return refuseRun(`${p.name} can't be guarded yet; it will run inside a container once container mode exists.`);
    const canWire = p.guard.wireMcp !== null;
    const readOnly = !this.o.hiveTools || !canWire;
    if (readOnly && !isReadOnlyRole(req.role)) {
      return refuseRun(
        canWire
          ? `${p.name} can only do read-only work here (the hive tools are missing), not ${req.role} work.`
          : `${p.name} can't load the hive tools, so it can only do read-only work, not ${req.role} work.`,
      );
    }
    const runDir = join(this.o.runBase, `${req.agentId}-${++this.#n}-${randomBytes(4).toString('hex')}`);
    const rt = this.o.runtime;
    const server = (script: string, own: Record<string, string>, cwd?: string) => ({
      command: rt.command,
      args: [...(rt.args ?? []), script],
      env: { ...rt.env, ...own },
      ...(cwd ? { cwd } : {}),
    });
    const mcpServers: HiveMcpServers = {};
    if (canWire) {
      if (!readOnly && this.o.hiveTools) {
        const guard: Omit<HookPolicy, 'realpath'> = { ...req.guard, platform: process.platform === 'win32' ? 'win32' : 'posix' };
        mcpServers.hive = server(this.o.hiveTools, { INSECTOIDS_GUARD: JSON.stringify(guard) }, req.cwd);
      }
      if (req.brain) mcpServers.brain = server(req.brain.doors.mcpScript, brainEnv(req.brain));
      if (req.services) mcpServers.services = server(req.services.door.mcpScript, servicesEnv(req.services));
    }
    return (this.o.run ?? runCommand)({
      preset: p,
      bin: this.o.bin,
      cwd: req.cwd,
      // Few CLIs can append to their system prompt, so the role brief leads the prompt (as for Gemini CLI).
      prompt: `${req.system}\n\n---\n\n${req.task}`,
      model: p.model ? req.route.model : null,
      effort: req.route.effort,
      maxTurns: req.route.maxTurns,
      timeoutMs: req.route.timeoutMs,
      mcpServers,
      readOnly,
      runDir,
      ...(req.onEvent ? { onEvent: req.onEvent } : {}),
    });
  }
}
