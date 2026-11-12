import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Caste } from '@insectoids/shared';
import type { HookPolicy } from '@insectoids/reflexes';
import type { ClaudeEvent } from '../claude/stream';
import { type RunResult, runClaude } from '../claude/run';
import type { Route } from './router';

/** One run of one agent. The hive never cares which AI tool does the work (Connections 04-D5). */
export interface EngineRequest {
  role: 'queen' | 'inspector' | Caste;
  agentId: string;
  /** Folder the agent works in. */
  cwd: string;
  system: string;
  task: string;
  route: Route;
  guard: Omit<HookPolicy, 'platform' | 'realpath'>;
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
      /** How to start the bundled guard hook, e.g. { command: process.execPath, args: [guardHookPath] }. */
      hook: { command: string; args: string[] };
      /** Where system-prompt files are written (outside every workspace). */
      promptDir: string;
      env?: Record<string, string>;
    },
  ) {}

  run(req: EngineRequest): EngineRun {
    mkdirSync(this.o.promptDir, { recursive: true });
    const file = join(this.o.promptDir, `${req.agentId}-${++this.#n}.md`);
    writeFileSync(file, req.system);
    return runClaude({
      bin: { command: this.o.claude, args: [] },
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
      ...(this.o.env ? { env: this.o.env } : {}),
      ...(req.onEvent ? { onEvent: req.onEvent } : {}),
    });
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
    const insect = req.role !== 'queen' && req.role !== 'inspector';
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
