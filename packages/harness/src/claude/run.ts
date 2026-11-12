import { type ChildProcess, spawn } from 'node:child_process';
import type { HookPolicy } from '@insectoids/reflexes';
import { type Effort, buildClaudeArgs, buildHookSettings } from './args';
import { type ClaudeEvent, type Usage, parseStreamLine } from './stream';

export type { ClaudeEvent } from './stream';

export interface RunOptions {
  /** The CLI to start: the real `claude` executable, or a stand-in in tests. */
  bin: { command: string; args: string[] };
  /** The card's workspace. */
  cwd: string;
  /** The card brief and instructions, sent on stdin. */
  prompt: string;
  model?: string;
  effort?: Effort;
  /** How to start the guard hook (e.g. Electron-as-Node + the bundled guard-hook.mjs). */
  hook: { command: string; args: string[] };
  /** The insect's guard policy, handed to the hook through the environment. */
  guard: Omit<HookPolicy, 'platform' | 'realpath'> & { platform?: HookPolicy['platform'] };
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPromptFile?: string;
  mcpConfig?: string;
  /** Hard wall-clock limit for the whole card. */
  timeoutMs?: number;
  env?: Record<string, string>;
  onEvent?: (e: ClaudeEvent) => void;
}

export type RunError = 'auth' | 'timeout' | 'stopped' | 'limit' | 'model-error' | 'crash';

export interface RunResult {
  ok: boolean;
  error?: RunError;
  /** Model the CLI reported at start-up. */
  model: string | null;
  /** Every model the CLI says it used (may include helpers). */
  models: string[];
  sessionId: string | null;
  text: string;
  usage: Usage;
  costUsd: number;
  numTurns: number;
  durationMs: number;
  exitCode: number | null;
  stderrTail: string;
}

export interface RunHandle {
  done: Promise<RunResult>;
  /** Watchdog breaker: stop now. */
  stop(): void;
}

const EMPTY_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const AUTH_HINT = /(\/login|api key|not logged in|authenticat|unauthori[sz]ed|credit balance)/i;

/** Ends the process and everything it started (its shells and tools). */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/** Run one card headless in Claude Code, with the command guard in front of every tool. */
export function runClaude(o: RunOptions): RunHandle {
  const args = buildClaudeArgs({
    settings: buildHookSettings(o.hook),
    ...(o.model ? { model: o.model } : {}),
    ...(o.effort ? { effort: o.effort } : {}),
    ...(o.maxTurns !== undefined ? { maxTurns: o.maxTurns } : {}),
    ...(o.maxBudgetUsd !== undefined ? { maxBudgetUsd: o.maxBudgetUsd } : {}),
    ...(o.systemPromptFile ? { systemPromptFile: o.systemPromptFile } : {}),
    ...(o.mcpConfig ? { mcpConfig: o.mcpConfig } : {}),
  });
  const guard: Omit<HookPolicy, 'realpath'> = { ...o.guard, platform: o.guard.platform ?? (process.platform === 'win32' ? 'win32' : 'posix') };
  const child = spawn(o.bin.command, [...o.bin.args, ...args], {
    cwd: o.cwd,
    env: { ...process.env, ...o.env, INSECTOIDS_GUARD: JSON.stringify(guard) },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });

  let stopped: RunError | null = null;
  let initModel: string | null = null;
  let sessionId: string | null = null;
  let final: Extract<ClaudeEvent, { kind: 'result' }> | null = null;
  let texts: string[] = [];
  let stderr = '';
  let buf = '';

  const handle = (line: string): void => {
    for (const e of parseStreamLine(line)) {
      if (e.kind === 'init') {
        initModel = e.model || null;
        sessionId = e.sessionId || null;
      }
      if (e.kind === 'text') texts.push(e.text);
      if (e.kind === 'result') final = e;
      o.onEvent?.(e);
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
    const finish = (exitCode: number | null): void => {
      if (timer) clearTimeout(timer);
      if (buf.trim()) handle(buf.trim());
      const r = final as Extract<ClaudeEvent, { kind: 'result' }> | null;
      let error: RunError | undefined = stopped ?? undefined;
      if (!error && r?.isError) {
        error = AUTH_HINT.test(r.result) ? 'auth' : /max_turns|budget/i.test(r.subtype) ? 'limit' : 'model-error';
      }
      if (!error && !r) error = AUTH_HINT.test(stderr) ? 'auth' : 'crash';
      resolve({
        ok: !error,
        ...(error ? { error } : {}),
        model: initModel,
        models: r?.models.length ? r.models : initModel ? [initModel] : [],
        sessionId: r?.sessionId || sessionId,
        text: r?.result || texts.join('\n'),
        usage: r?.usage ?? EMPTY_USAGE,
        costUsd: r?.costUsd ?? 0,
        numTurns: r?.numTurns ?? 0,
        durationMs: r?.durationMs ?? 0,
        exitCode,
        stderrTail: stderr,
      });
      texts = [];
    };
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });

  return {
    done,
    stop: () => {
      stopped ??= 'stopped';
      killTree(child);
    },
  };
}
