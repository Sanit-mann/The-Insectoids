import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { HookPolicy } from '@insectoids/reflexes';
import type { RunHandle } from '../claude/run';
import { brainEnv } from '../hive/brain-access';
import type { Engine, EngineRequest, EngineRun } from '../hive/engine';
import { isReadOnlyRole } from '../hive/router';
import type { GeminiMcpServer } from './args';
import { runGemini } from './run';

export interface GeminiEngineOptions {
  /**
   * Node.js that runs Gemini CLI and the hive's MCP servers in Gemini runs. Gemini CLI refuses to pass
   * ELECTRON_RUN_AS_NODE to MCP servers, so the app's own executable can't stand in for Node here; Gemini
   * CLI needs Node.js 20+ anyway (it is an npm install).
   */
  node: string;
  /** Gemini CLI's bundle/gemini.js. */
  script: string;
  /** The hive tools MCP bundle; null = not built, so Gemini runs read-only work only. */
  hiveTools: string | null;
  /** Per-run settings and policy folders go here (outside every workspace). */
  runBase: string;
  /** Tests: a stand-in CLI instead of the real one (still gets node + script + args). */
  run?: typeof runGemini;
}

const MCP_TIMEOUT_MS = 10 * 60_000;

/** The hive's runs on Gemini CLI (Connections 04-D2). */
export class GeminiEngine implements Engine {
  #n = 0;

  constructor(private readonly o: GeminiEngineOptions) {}

  run(req: EngineRequest): EngineRun {
    const readOnly = !this.o.hiveTools;
    if (readOnly && !isReadOnlyRole(req.role)) {
      // The router never sends this; refusing here keeps the rule even if something else does.
      return refuse(`Gemini CLI can only do read-only work here (the hive tools are missing), not ${req.role} work.`);
    }
    const n = ++this.#n;
    const runDir = join(this.o.runBase, `${req.agentId}-${n}-${randomBytes(4).toString('hex')}`);
    const guard: Omit<HookPolicy, 'realpath'> = { ...req.guard, platform: process.platform === 'win32' ? 'win32' : 'posix' };
    const mcpServers: Record<string, GeminiMcpServer> = {};
    if (this.o.hiveTools) {
      mcpServers['hive'] = {
        command: this.o.node,
        args: [this.o.hiveTools],
        env: { INSECTOIDS_GUARD: JSON.stringify(guard) },
        cwd: req.cwd,
        timeout: MCP_TIMEOUT_MS,
      };
    }
    if (req.brain) {
      mcpServers['brain'] = { command: this.o.node, args: [req.brain.doors.mcpScript], env: brainEnv(req.brain), timeout: MCP_TIMEOUT_MS };
    }
    const handle: RunHandle = (this.o.run ?? runGemini)({
      bin: { command: this.o.node, args: [this.o.script] },
      cwd: req.cwd,
      // Gemini CLI has no "append to the system prompt" flag (GEMINI_SYSTEM_MD would replace its own),
      // so the role brief leads the prompt.
      prompt: `${req.system}\n\n---\n\n${req.task}`,
      model: req.route.model,
      effort: req.route.effort,
      maxTurns: req.route.maxTurns,
      timeoutMs: req.route.timeoutMs,
      mcpServers,
      readOnly,
      runDir,
      ...(req.onEvent ? { onEvent: req.onEvent } : {}),
    });
    return handle;
  }
}

function refuse(reason: string): EngineRun {
  return {
    done: Promise.resolve({
      ok: false,
      error: 'crash',
      model: null,
      models: [],
      sessionId: null,
      text: '',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      costEstimated: true,
      numTurns: 0,
      durationMs: 0,
      exitCode: null,
      stderrTail: reason,
    }),
    stop: () => {},
  };
}
