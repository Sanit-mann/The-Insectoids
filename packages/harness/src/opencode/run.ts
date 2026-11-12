import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { type RunError, type RunHandle, type RunResult, killTree } from '../claude/run';
import type { ClaudeEvent, Usage } from '../claude/stream';
import type { ModelTiers } from '../hive/router';
import { FORBIDDEN_FLAGS, type HiveMcpName, type OpenCodeMcpServer, buildOpenCodeArgs, buildOpenCodeConfig, buildOpenCodeEnv, modelKeyFor } from './config';
import { estimateOpenCodeCost, parseOpenCodeLine } from './stream';

/** What the broker saw for one pass: the source of truth for the model that answered and the tokens. */
export interface LlmUsage {
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  calls: number;
}

export interface OpenCodeRunOptions {
  /** The OpenCode executable (never an npm .cmd launcher; never a shell). */
  command: string;
  /** Leading arguments before `run …` (tests: a stand-in script run by Node). */
  commandArgs?: string[];
  /** The card's workspace. */
  cwd: string;
  /** Role brief + task, sent on stdin (never in the config, which OpenCode substitutes). */
  prompt: string;
  title: string;
  /** Upstream model id to use (one of the provider's tiers). */
  model: string;
  tiers: ModelTiers;
  /** The broker's LLM route and this run's pass. */
  baseUrl: string;
  pass: string;
  /** Runs on this computer (cost 0 when nothing reports one). */
  local: boolean;
  mcpServers: Partial<Record<HiveMcpName, OpenCodeMcpServer>>;
  readOnly: boolean;
  maxSteps?: number;
  timeoutMs?: number;
  /** A fresh folder for this run's empty config/data dirs, outside every workspace; deleted afterwards. */
  runDir: string;
  /** Base environment (default: this process's). */
  env?: NodeJS.ProcessEnv;
  /** Read the broker's usage for this pass once the run ends. */
  usage?: () => Promise<LlmUsage | null>;
  onEvent?: (e: ClaudeEvent) => void;
}

const EMPTY: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function runOpenCode(o: OpenCodeRunOptions): RunHandle {
  let config: string;
  try {
    config = JSON.stringify(
      buildOpenCodeConfig({
        baseUrl: o.baseUrl,
        tiers: o.tiers,
        mcpServers: o.mcpServers,
        readOnly: o.readOnly,
        ...(o.maxSteps ? { maxSteps: o.maxSteps } : {}),
      }),
    );
  } catch (err) {
    return refuse(err instanceof Error ? err.message : String(err));
  }
  const args = buildOpenCodeArgs({ modelKey: modelKeyFor(o.tiers, o.model), title: o.title });
  if (args.some((a) => (FORBIDDEN_FLAGS as readonly string[]).includes(a))) return refuse('Refusing an auto-approve flag.');
  mkdirSync(o.runDir, { recursive: true });
  const cleanup = (): void => rmSync(o.runDir, { recursive: true, force: true, maxRetries: 3 });
  const env = buildOpenCodeEnv({ base: o.env ?? process.env, runDir: o.runDir, workspace: o.cwd, pass: o.pass, config });

  const child = spawn(o.command, [...(o.commandArgs ?? []), ...args], {
    cwd: o.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });

  const started = Date.now();
  let stopped: RunError | null = null;
  let sessionId: string | null = null;
  let costUsd = 0;
  const usage: Usage = { ...EMPTY };
  const texts: string[] = [];
  const errors: Array<{ message: string; status: number | null }> = [];
  let steps = 0;
  let stderr = '';
  let buf = '';

  const handle = (line: string): void => {
    for (const l of parseOpenCodeLine(line)) {
      if (l.kind === 'session') {
        if (!sessionId) {
          sessionId = l.sessionId;
          o.onEvent?.({ kind: 'init', sessionId: l.sessionId, model: o.model });
        }
      } else if (l.kind === 'event') {
        if (l.event.kind === 'text') texts.push(l.event.text);
        o.onEvent?.(l.event);
      } else if (l.kind === 'step') {
        steps++;
        costUsd += l.costUsd;
        usage.input += l.usage.input;
        usage.output += l.usage.output;
        usage.cacheRead += l.usage.cacheRead;
        usage.cacheWrite += l.usage.cacheWrite;
      } else {
        errors.push({ message: l.message, status: l.status });
        o.onEvent?.({ kind: 'text', text: `OpenCode error: ${l.message}` });
      }
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handle(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(o.prompt);

  const timer = o.timeoutMs
    ? setTimeout(() => {
        stopped = 'timeout';
        killTree(child);
      }, o.timeoutMs)
    : null;

  const done = new Promise<RunResult>((resolve) => {
    let finished = false;
    const finish = async (exitCode: number | null): Promise<void> => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (buf.trim()) handle(buf.trim());
      cleanup();
      // The broker saw every model call of this run: its model and tokens win over the stream's.
      const seen = await (o.usage?.() ?? Promise.resolve(null)).catch(() => null);
      const finalUsage: Usage = seen && seen.calls > 0 ? { input: seen.input, output: seen.output, cacheRead: seen.cacheRead, cacheWrite: usage.cacheWrite } : usage;
      const models = seen?.model ? [seen.model] : [o.model];
      const reported = costUsd > 0;
      const cost = reported ? Math.round(costUsd * 1e6) / 1e6 : estimateOpenCodeCost(finalUsage, o.local);
      const why = [...errors.map((e) => e.message), stderr].filter(Boolean).join('\n');
      let error: RunError | undefined = stopped ?? undefined;
      if (!error && errors.some((e) => e.status === 401 || e.status === 403)) error = 'auth';
      if (!error && exitCode === 130) error = 'stopped';
      if (!error && (exitCode !== 0 || errors.length)) error = errors.length ? 'model-error' : 'crash';
      o.onEvent?.({
        kind: 'result',
        isError: Boolean(error),
        subtype: error ?? 'success',
        result: texts.join('\n'),
        sessionId: sessionId ?? '',
        numTurns: steps,
        durationMs: Date.now() - started,
        costUsd: cost,
        usage: finalUsage,
        models,
      });
      resolve({
        ok: !error,
        ...(error ? { error } : {}),
        model: models[0] ?? null,
        models,
        sessionId,
        text: texts.join('\n'),
        usage: finalUsage,
        costUsd: cost,
        costEstimated: !reported,
        numTurns: steps,
        durationMs: Date.now() - started,
        exitCode,
        stderrTail: why.slice(-4096),
      });
    };
    child.on('error', () => void finish(null));
    child.on('close', (code) => void finish(code));
  });

  return {
    done,
    stop: () => {
      stopped ??= 'stopped';
      killTree(child);
    },
  };
}

export function refuse(reason: string): RunHandle {
  return {
    done: Promise.resolve({
      ok: false,
      error: 'crash',
      model: null,
      models: [],
      sessionId: null,
      text: '',
      usage: EMPTY,
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
