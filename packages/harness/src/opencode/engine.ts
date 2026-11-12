import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { HookPolicy } from '@insectoids/reflexes';
import type { RunHandle, RunResult } from '../claude/run';
import { brainEnv } from '../hive/brain-access';
import type { Engine, EngineRequest, EngineRun } from '../hive/engine';
import { type ModelTiers, isReadOnlyRole } from '../hive/router';
import { servicesEnv } from '../hive/services-access';
import { type HiveMcpName, type OpenCodeMcpServer, mcpEnvironment } from './config';
import { type LlmUsage, refuse, runOpenCode } from './run';

/** A model provider that is switched on and passed its test (from the API providers tab, via main). */
export interface ReadyProvider {
  id: string;
  label: string;
  local: boolean;
  models: ModelTiers;
}

/**
 * The broker's LLM route, reached through main (host → main requests). A pass is a short-lived stand-in
 * for the provider key: the engine only ever sees the pass and the broker's address.
 */
export interface LlmAccess {
  issue(runId: string, providerId: string): Promise<{ baseUrl: string; pass: string }>;
  usage(pass: string): Promise<LlmUsage | null>;
  revoke(pass: string): Promise<void>;
}

export interface OpenCodeEngineOptions {
  /** The OpenCode executable. */
  command: string;
  /** Tests: leading arguments (a stand-in script run by Node). */
  commandArgs?: string[];
  /** The hive tools MCP bundle; null = not built, so OpenCode gets only read-only work (no file access). */
  hiveTools: string | null;
  /** Runtime for the hive's MCP servers (the app's own executable as Node: its env goes only to them). */
  runtime: { command: string; args?: string[]; env?: Record<string, string> };
  /** The provider runs use (first enabled, ready one in the user's order). */
  provider: () => ReadyProvider | null;
  llm: LlmAccess;
  /** Per-run folders go here (outside every workspace). */
  runBase: string;
  /** Tests: a stand-in for runOpenCode. */
  run?: typeof runOpenCode;
}

/** The hive's runs on OpenCode, with an OpenAI-compatible provider behind the secret broker (04-D3, D4). */
export class OpenCodeEngine implements Engine {
  #n = 0;

  constructor(private readonly o: OpenCodeEngineOptions) {}

  run(req: EngineRequest): EngineRun {
    const readOnly = !this.o.hiveTools;
    if (readOnly && !isReadOnlyRole(req.role)) {
      return refuse(`OpenCode can only do read-only work here (the hive tools are missing), not ${req.role} work.`);
    }
    const provider = this.o.provider();
    if (!provider) return { ...refuse('No API provider is ready. Add one on the API providers tab.'), done: authFail('No API provider is ready.') };
    const n = ++this.#n;
    const runId = `${req.agentId}-${n}-${randomBytes(4).toString('hex')}`;
    const runDir = join(this.o.runBase, runId);
    const userProgramData = process.env['ProgramData'] ?? process.env['PROGRAMDATA'];
    const server = (script: string, own: Record<string, string>, cwd?: string): OpenCodeMcpServer => ({
      command: [this.o.runtime.command, ...(this.o.runtime.args ?? []), script],
      environment: mcpEnvironment({ ...this.o.runtime.env, ...own }, userProgramData),
      ...(cwd ? { cwd } : {}),
    });
    const mcpServers: Partial<Record<HiveMcpName, OpenCodeMcpServer>> = {};
    if (this.o.hiveTools) {
      const guard: Omit<HookPolicy, 'realpath'> = { ...req.guard, platform: process.platform === 'win32' ? 'win32' : 'posix' };
      mcpServers.hive = server(this.o.hiveTools, { INSECTOIDS_GUARD: JSON.stringify(guard) }, req.cwd);
    }
    if (req.brain) mcpServers.brain = server(req.brain.doors.mcpScript, brainEnv(req.brain));
    if (req.services) mcpServers.services = server(req.services.door.mcpScript, servicesEnv(req.services));

    let inner: RunHandle | null = null;
    let stopRequested = false;
    const done = (async (): Promise<RunResult> => {
      let pass: string | null = null;
      try {
        const ticket = await this.o.llm.issue(runId, provider.id);
        pass = ticket.pass;
        if (stopRequested) return (await refuse('Stopped before it started.').done) as RunResult;
        inner = (this.o.run ?? runOpenCode)({
          command: this.o.command,
          ...(this.o.commandArgs ? { commandArgs: this.o.commandArgs } : {}),
          cwd: req.cwd,
          prompt: `${req.system}\n\n---\n\n${req.task}`,
          title: req.title ?? `${req.role} card`,
          model: req.route.model,
          tiers: provider.models,
          baseUrl: ticket.baseUrl,
          pass: ticket.pass,
          local: provider.local,
          mcpServers,
          readOnly,
          maxSteps: req.route.maxTurns,
          timeoutMs: req.route.timeoutMs,
          runDir,
          usage: () => this.o.llm.usage(ticket.pass),
          ...(req.onEvent ? { onEvent: req.onEvent } : {}),
        });
        return await inner.done;
      } catch (err) {
        return { ...(await refuse(`Could not start OpenCode: ${err instanceof Error ? err.message : String(err)}`).done) };
      } finally {
        if (pass) await this.o.llm.revoke(pass).catch(() => {});
      }
    })();
    return {
      done,
      stop: () => {
        stopRequested = true;
        inner?.stop();
      },
    };
  }
}

async function authFail(reason: string): Promise<RunResult> {
  const r = await refuse(reason).done;
  return { ...r, error: 'auth' };
}
