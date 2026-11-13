import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HookPolicy } from '@insectoids/reflexes';
import type { ClaudeEvent } from '../claude/stream';
import { type RunResult, runClaude } from '../claude/run';
import { type RunBrain, brainMcpConfig, brainRunEnv } from './brain-access';
import { type RunServices, servicesMcpServer } from './services-access';
import { type AgentRole, type Route, isInsectRole } from './router';

/** One run of one agent. The hive never cares which AI tool does the work (Connections 04-D5). */
export interface EngineRequest {
  role: AgentRole;
  agentId: string;
  /** What this run works on, for display (goal or card title). */
  title?: string;
  /** Folder the agent works in. */
  cwd: string;
  system: string;
  task: string;
  route: Route;
  guard: Omit<HookPolicy, 'platform' | 'realpath'>;
  /** Brain access for this run (a scoped token and the doors); absent when the hive has none. */
  brain?: RunBrain;
  /** Outside services through the secret broker; only when the card named integrations that were granted. */
  services?: RunServices;
  onEvent?: (e: ClaudeEvent) => void;
}

export type EngineResult = RunResult;

export interface EngineRun {
  done: Promise<EngineResult>;
  stop(): void;
}

export interface Engine {
  run(req: EngineRequest): EngineRun;
}

/** Claude Code engine: each run is a headless Claude Code process with the guard hook in front of every tool. */
export class ClaudeEngine implements Engine {
  #n = 0;

  constructor(
    private readonly o: {
      claude: string;
      /** Leading arguments for `claude` (e.g. a script path when it runs through a runtime, as in tests). */
      claudeArgs?: string[];
      /** How to start the bundled guard hook, e.g. { command: process.execPath, args: [guardHookPath] }. */
      hook: { command: string; args: string[] };
      /** Where system-prompt files are written (outside every workspace). */
      promptDir: string;
      env?: Record<string, string>;
    },
  ) {}

  run(req: EngineRequest): EngineRun {
    mkdirSync(this.o.promptDir, { recursive: true });
    const n = ++this.#n;
    const file = join(this.o.promptDir, `${req.agentId}-${n}.md`);
    writeFileSync(file, req.system);
    // The Brain door: an MCP config holding this run's token, next to the prompt (outside every workspace).
    // The services door gets the broker address and token in its own server env only: never in Claude's
    // environment, so neither the model's shell nor its other tools can read the token.
    let mcpFile: string | undefined;
    let env = this.o.env;
    const servers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
    if (req.brain) {
      Object.assign(servers, brainMcpConfig(req.brain).mcpServers);
      env = { ...this.o.env, ...brainRunEnv(req.brain, { ...process.env, ...this.o.env }) };
    }
    if (req.services) servers['services'] = servicesMcpServer(req.services);
    if (Object.keys(servers).length) {
      mcpFile = join(this.o.promptDir, `${req.agentId}-${n}.mcp.json`);
      writeFileSync(mcpFile, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });
    }
    const handle = runClaude({
      bin: { command: this.o.claude, args: this.o.claudeArgs ?? [] },
      cwd: req.cwd,
      prompt: req.task,
      model: req.route.model,
      effort: req.route.effort,
      maxTurns: req.route.maxTurns,
      maxBudgetUsd: req.route.maxBudgetUsd,
      timeoutMs: req.route.timeoutMs,
      systemPromptFile: file,
      hook: this.o.hook,
      guard: req.guard,
      ...(mcpFile ? { mcpConfig: mcpFile } : {}),
      ...(env ? { env } : {}),
      ...(req.onEvent ? { onEvent: req.onEvent } : {}),
    });
    if (!mcpFile) return handle;
    const config = mcpFile;
    return { done: handle.done.finally(() => rmSync(config, { force: true })), stop: handle.stop };
  }
}

/** What a scripted run should do (tests and demos without spending tokens). */
export interface FakeReply {
  text: string;
  ok?: boolean;
  error?: EngineResult['error'];
  costUsd?: number;
  tokens?: number;
  /** Do work in the run's folder, like an agent would. */
  effects?: (cwd: string) => void;
  /** Events to report while "running" (e.g. a guard denial). */
  events?: ClaudeEvent[];
  delayMs?: number;
}

export class FakeEngine implements Engine {
  readonly calls: EngineRequest[] = [];
  #running = 0;
  #insects = 0;
  maxConcurrent = 0;
  /** Most insects (not Queen or Inspector) running at the same time. */
  maxConcurrentInsects = 0;

  constructor(private readonly script: (req: EngineRequest, callIndex: number) => FakeReply) {}

  run(req: EngineRequest): EngineRun {
    const index = this.calls.push(req) - 1;
    const reply = this.script(req, index);
    const insect = isInsectRole(req.role);
    this.#running++;
    if (insect) this.#insects++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.#running);
    this.maxConcurrentInsects = Math.max(this.maxConcurrentInsects, this.#insects);
    let stopped = false;
    const done = (async (): Promise<EngineResult> => {
      await new Promise((r) => setTimeout(r, reply.delayMs ?? 0));
      this.#running--;
      if (insect) this.#insects--;
      if (stopped) return result(reply, false, 'stopped');
      reply.effects?.(req.cwd);
      for (const e of reply.events ?? []) req.onEvent?.(e);
      return result(reply, reply.ok ?? true, reply.error);
    })();
    return {
      done,
      stop: () => {
        stopped = true;
      },
    };

    function result(r: FakeReply, ok: boolean, error?: EngineResult['error']): EngineResult {
      return {
        ok,
        ...(ok ? {} : { error: error ?? 'model-error' }),
        model: req.route.model,
        models: [req.route.model],
        sessionId: null,
        text: r.text,
        usage: { input: r.tokens ?? 1_000, output: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: r.costUsd ?? 0.001,
        numTurns: 1,
        durationMs: r.delayMs ?? 0,
        exitCode: 0,
        stderrTail: '',
      };
    }
  }
}
