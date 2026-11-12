import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Effort } from '../claude/args';
import { type RunError, type RunHandle, type RunResult, killTree } from '../claude/run';
import type { ClaudeEvent, Usage } from '../claude/stream';
import { type GeminiMcpServer, buildGeminiArgs, buildGeminiPolicy, buildGeminiSettings } from './args';
import { type GeminiLine, estimateGeminiCost, parseGeminiLine } from './stream';

export interface GeminiRunOptions {
  /** How to start Gemini CLI: Node.js + bundle/gemini.js (never the gemini.cmd launcher, never a shell). */
  bin: { command: string; args: string[] };
  /** The card's workspace. */
  cwd: string;
  /** Role brief + task (Gemini has no "append to system prompt" flag), sent on stdin. */
  prompt: string;
  model?: string;
  effort?: Effort;
  maxTurns?: number;
  timeoutMs?: number;
  /** The run's MCP servers: `hive` (guarded tools) and `brain`. Nothing else loads. */
  mcpServers: Record<string, GeminiMcpServer>;
  /** No hive tools available: read-only castes only, built-in read tools in plan mode. */
  readOnly: boolean;
  /** A fresh folder for this run's settings and policy, outside every workspace; deleted afterwards. */
  runDir: string;
  env?: Record<string, string>;
  onEvent?: (e: ClaudeEvent) => void;
}

const EMPTY_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const AUTH_HINT = /(login|log in|sign in|authenticat|unauthori[sz]ed|credentials|oauth|permission denied|403)/i;
/** Environment the Gemini process must never carry into anything it starts. */
const SCRUB = ['ELECTRON_RUN_AS_NODE', 'INSECTOIDS_GUARD', 'INSECTOIDS_BRAIN_TOKEN', 'GEMINI_CLI_HOME', 'GEMINI_SYSTEM_MD', 'GEMINI_CLI_TRUST_WORKSPACE', 'NODE_OPTIONS'];

/** Gemini CLI exit codes (0.68.0): 41 sign-in, 42 input, 44 sandbox, 52 config, 53 turn limit, 54 tool error, 55 untrusted folder, 130 cancelled. */
export function geminiExitError(code: number | null): RunError | undefined {
  if (code === 0) return undefined;
  if (code === 41) return 'auth';
  if (code === 53) return 'limit';
  if (code === 130) return 'stopped';
  if (code === 42 || code === 52 || code === 54 || code === 55 || code === 44) return 'model-error';
  return 'crash';
}

/**
 * MCP server env values are expanded by Gemini CLI ($VAR, ${VAR}, and %VAR% on Windows), which would
 * silently change a guard policy or token. Such values are refused instead of being passed on.
 */
export function unsafeForGeminiEnv(value: string): boolean {
  return /\$/.test(value) || /%\w+%/.test(value);
}

/**
 * Run one card headless in Gemini CLI. The command guard is enforced without relying on Gemini's hooks
 * (they fail open): built-in tools are denied by the run's admin policy, and every change goes through
 * the hive's own MCP tools, which check the guard before acting and refuse on any error.
 */
export function runGemini(o: GeminiRunOptions): RunHandle {
  const contextFileName = `.insectoids-no-context-${Date.now().toString(36)}.md`;
  for (const [name, server] of Object.entries(o.mcpServers)) {
    for (const [key, value] of Object.entries(server.env ?? {})) {
      if (unsafeForGeminiEnv(value)) {
        return refuse(`The ${name} server's ${key} contains "$" or "%NAME%", which Gemini CLI would expand. Refusing to run.`);
      }
    }
  }
  mkdirSync(o.runDir, { recursive: true });
  const settingsFile = join(o.runDir, 'settings.json');
  const policyFile = join(o.runDir, 'policy.toml');
  writeFileSync(
    settingsFile,
    JSON.stringify(
      buildGeminiSettings({
        mcpServers: o.mcpServers,
        ...(o.maxTurns ? { maxTurns: o.maxTurns } : {}),
        ...(o.effort ? { effort: o.effort } : {}),
        contextFileName,
      }),
      null,
      2,
    ),
    { mode: 0o600 },
  );
  writeFileSync(policyFile, buildGeminiPolicy({ readOnly: o.readOnly }), { mode: 0o600 });
  const cleanup = (): void => rmSync(o.runDir, { recursive: true, force: true });

  const env: NodeJS.ProcessEnv = { ...process.env, ...o.env };
  for (const key of SCRUB) delete env[key];
  env['GEMINI_CLI_SYSTEM_SETTINGS_PATH'] = settingsFile;
  env['GEMINI_CLI_NO_RELAUNCH'] = 'true';

  const args = buildGeminiArgs({ ...(o.model ? { model: o.model } : {}), policyFile, readOnly: o.readOnly });
  const child = spawn(o.bin.command, [...o.bin.args, ...args], {
    cwd: o.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });

  let stopped: RunError | null = null;
  let initModel: string | null = null;
  let sessionId: string | null = null;
  let final: Extract<GeminiLine, { kind: 'result' }> | null = null;
  let pending = '';
  const texts: string[] = [];
  const errors: string[] = [];
  let stderr = '';
  let buf = '';

  // Gemini streams text in small deltas; they become one text event per turn, like Claude's.
  const flush = (): void => {
    if (!pending.trim()) return;
    texts.push(pending);
    o.onEvent?.({ kind: 'text', text: pending });
    pending = '';
  };
  const handle = (line: string): void => {
    for (const l of parseGeminiLine(line)) {
      if (l.kind === 'delta') {
        pending += l.text;
        continue;
      }
      flush();
      if (l.kind === 'init') {
        initModel = l.model || null;
        sessionId = l.sessionId || null;
        o.onEvent?.({ kind: 'init', sessionId: l.sessionId, model: l.model });
      } else if (l.kind === 'event') {
        o.onEvent?.(l.event);
      } else if (l.kind === 'error') {
        errors.push(l.message);
        o.onEvent?.({ kind: 'text', text: `Gemini ${l.severity}: ${l.message}` });
      } else {
        final = l;
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
    const finish = (exitCode: number | null): void => {
      if (timer) clearTimeout(timer);
      if (buf.trim()) handle(buf.trim());
      flush();
      cleanup();
      const r = final as Extract<GeminiLine, { kind: 'result' }> | null;
      const usage = r?.usage ?? EMPTY_USAGE;
      const models = r?.models.length ? r.models : initModel ? [initModel] : [];
      const why = [r?.errorMessage, ...errors, stderr].filter(Boolean).join('\n');
      let error: RunError | undefined = stopped ?? undefined;
      if (!error && r && !r.ok) error = AUTH_HINT.test(`${r.errorType} ${r.errorMessage}`) ? 'auth' : /turn/i.test(r.errorType) ? 'limit' : 'model-error';
      if (!error) error = geminiExitError(exitCode);
      if (!error && !r) error = 'crash';
      if (error === 'crash' && AUTH_HINT.test(why)) error = 'auth';
      const costUsd = estimateGeminiCost(models, usage);
      o.onEvent?.({
        kind: 'result',
        isError: Boolean(error),
        subtype: r?.errorType || (error ?? 'success'),
        result: texts.join('\n'),
        sessionId: sessionId ?? '',
        numTurns: r?.toolCalls ?? 0,
        durationMs: r?.durationMs ?? 0,
        costUsd,
        usage,
        models,
      });
      resolve({
        ok: !error,
        ...(error ? { error } : {}),
        model: initModel,
        models,
        sessionId,
        text: texts.join('\n'),
        usage,
        costUsd,
        costEstimated: true,
        numTurns: r?.toolCalls ?? 0,
        durationMs: r?.durationMs ?? 0,
        exitCode,
        stderrTail: why.slice(-4096),
      });
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

function refuse(reason: string): RunHandle {
  return {
    done: Promise.resolve({
      ok: false,
      error: 'crash',
      model: null,
      models: [],
      sessionId: null,
      text: '',
      usage: EMPTY_USAGE,
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
