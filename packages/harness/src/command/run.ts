import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import type { Effort } from '../claude/args';
import { type RunError, type RunHandle, type RunResult, killTree } from '../claude/run';
import type { ClaudeEvent, Usage } from '../claude/stream';
import { USAGE_FILE, buildCommandInvocation } from './args';
import type { CommandEvent, CommandPreset, HiveMcpServers } from './preset';

export interface CommandRunOptions {
  preset: CommandPreset;
  /** The resolved program (never a .cmd launcher, never a shell); args lead (e.g. a script for Node). */
  bin: { command: string; args: string[] };
  /** The card's workspace. */
  cwd: string;
  /** Role brief + task. */
  prompt: string;
  model: string | null;
  effort?: Effort;
  maxTurns?: number;
  timeoutMs?: number;
  mcpServers: HiveMcpServers;
  readOnly: boolean;
  /** A fresh folder for this run's config and prompt files, outside every workspace; deleted afterwards. */
  runDir: string;
  /** Base environment (default: this process's). */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  onEvent?: (e: ClaudeEvent) => void;
}

const EMPTY: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** The hive's own variables: never in a CLI's environment (its shell, if any, would inherit them). */
const SCRUB = [
  'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'INSECTOIDS_GUARD', 'INSECTOIDS_BRAIN_TOKEN', 'INSECTOIDS_BRAIN_ENDPOINT',
  'INSECTOIDS_BROKER_TOKEN', 'INSECTOIDS_BROKER_URL',
];
const AUTH_HINT = /(not (?:signed|logged) in|please (?:sign|log) ?in|unauthori[sz]ed|authenticat\w* (?:failed|required)|invalid (?:api key|token|credentials))/i;
const QUOTA_HINT = /(usage limit|rate[ -]?limit|quota|too many requests|\b429\b)/i;

/** True when `inner` is `outer` or inside it (Windows paths ignore case). */
export function isInside(inner: string, outer: string, platform: NodeJS.Platform = process.platform): boolean {
  const P = platform === 'win32' ? win32 : posix;
  const fold = (p: string): string => (platform === 'win32' ? P.resolve(p).toLowerCase() : P.resolve(p));
  const rel = P.relative(fold(outer), fold(inner));
  return rel === '' || (!rel.startsWith('..') && !P.isAbsolute(rel));
}

/** The environment for a run: the user's, minus the hive's own secrets and anything the preset names. */
export function buildCommandEnv(base: NodeJS.ProcessEnv, preset: CommandPreset, extra: Record<string, string>): Record<string, string> {
  const drop = new Set([...SCRUB, ...(preset.scrubEnv ?? []), ...Object.keys(extra)].map((k) => k.toUpperCase()));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !drop.has(k.toUpperCase())) env[k] = v;
  return { ...env, ...extra };
}

/** USD for a run the CLI didn't price, from the preset's per-million-token prices (0 when it has none). */
export function estimateCommandCost(preset: CommandPreset, usage: Usage): number {
  const p = preset.pricePerMTok;
  if (!p) return 0;
  // tokens × USD per million tokens = micro-dollars; rounded to whole micro-dollars.
  return Math.round((usage.input + usage.cacheWrite) * p.input + usage.output * p.output) / 1e6;
}

/**
 * Runs one card headless in a preset's CLI: its own file and shell tools switched off by the preset's flags,
 * the hive's guarded tools loaded over MCP, the per-run wiring in a fresh folder outside the workspace.
 */
export function runCommand(o: CommandRunOptions): RunHandle {
  const p = o.preset;
  const platform = o.platform ?? process.platform;
  if (isInside(o.runDir, o.cwd, platform)) return refuseRun(`${p.name}'s run folder must be outside the workspace. Refusing to run.`);
  let inv: ReturnType<typeof buildCommandInvocation>;
  try {
    inv = buildCommandInvocation(p, {
      prompt: o.prompt,
      model: o.model,
      ...(o.effort ? { effort: o.effort } : {}),
      ...(o.maxTurns ? { maxTurns: o.maxTurns } : {}),
      mcpServers: o.mcpServers,
      readOnly: o.readOnly,
      runDir: o.runDir,
      platform,
    });
  } catch (err) {
    return refuseRun(err instanceof Error ? err.message : String(err));
  }
  const cleanup = (): void => rmSync(o.runDir, { recursive: true, force: true, maxRetries: 3 });
  try {
    mkdirSync(o.runDir, { recursive: true });
    for (const f of inv.files) {
      const path = join(o.runDir, f.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, f.content, { mode: 0o600 });
    }
  } catch (err) {
    cleanup();
    return refuseRun(`Could not prepare ${p.name}'s run folder: ${err instanceof Error ? err.message : String(err)}`);
  }

  const child = spawn(o.bin.command, [...o.bin.args, ...inv.args], {
    cwd: o.cwd,
    env: buildCommandEnv(o.env ?? process.env, p, inv.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    detached: platform !== 'win32',
  });

  const started = Date.now();
  const requested = o.model ?? p.model?.tiers.standard ?? null;
  let stopped: RunError | null = null;
  let spawnError: string | null = null;
  let final: Extract<CommandEvent, { kind: 'final' }> | null = null;
  const usage: Usage = { ...EMPTY };
  let reportedCost = 0;
  const models = new Set<string>();
  const texts: string[] = [];
  const errors: Array<Extract<CommandEvent, { kind: 'error' }>> = [];
  let tools = 0;
  let stderr = '';
  let buf = '';

  o.onEvent?.({ kind: 'init', sessionId: '', model: requested ?? '' });

  const take = (e: CommandEvent): void => {
    if (e.kind === 'text') {
      if (!e.text) return;
      texts.push(e.text);
      o.onEvent?.({ kind: 'text', text: e.text });
    } else if (e.kind === 'tool') {
      tools++;
      o.onEvent?.({ kind: 'tool_use', id: e.id ?? `tool-${tools}`, name: e.name, input: e.input ?? null });
    } else if (e.kind === 'usage') {
      usage.input += e.usage.input ?? 0;
      usage.output += e.usage.output ?? 0;
      usage.cacheRead += e.usage.cacheRead ?? 0;
      usage.cacheWrite += e.usage.cacheWrite ?? 0;
      if (e.model) models.add(e.model);
      reportedCost += e.costUsd ?? 0;
    } else if (e.kind === 'final') {
      final = e;
      if (e.model) models.add(e.model);
    } else {
      errors.push(e);
      o.onEvent?.({ kind: 'text', text: `${p.name} error: ${e.message}` });
    }
  };
  // A CLI that writes its token counts to a file at the end (Copilot): read before the run folder goes.
  const readUsageFile = (): void => {
    if (!p.usageFile) return;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(join(o.runDir, USAGE_FILE), 'utf8'));
    } catch {
      return;
    }
    const got = safeUsage(p.usageFile.parse, json);
    if (!got) return;
    take({ kind: 'usage', usage: got.usage, ...(got.costUsd !== undefined ? { costUsd: got.costUsd } : {}) });
    for (const m of got.models ?? []) models.add(m);
  };
  const lines = (chunk: string[]): void => {
    if (p.output.format === 'jsonl') {
      for (const l of chunk) if (l.trim()) for (const e of safeParse(p.output.parse, l.trim())) take(e);
    } else {
      const text = chunk.join('\n').trimEnd();
      if (text.trim()) take({ kind: 'text', text });
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    const nl = buf.lastIndexOf('\n');
    if (nl < 0) return;
    const complete = buf.slice(0, nl).split(/\r?\n/);
    buf = buf.slice(nl + 1);
    lines(complete);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(inv.stdin ?? undefined);

  const timer = o.timeoutMs
    ? setTimeout(() => {
        stopped = 'timeout';
        killTree(child);
      }, o.timeoutMs)
    : null;

  const done = new Promise<RunResult>((resolveDone) => {
    let finished = false;
    const finish = (exitCode: number | null): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (buf.trim()) lines([buf]);
      buf = '';
      readUsageFile();
      cleanup();
      const f = final as Extract<CommandEvent, { kind: 'final' }> | null;
      const text = f?.text || texts.join('\n');
      const why = [spawnError, f?.errorMessage, ...errors.map((e) => e.message), stderr].filter(Boolean).join('\n');
      let error: RunError | undefined = stopped ?? undefined;
      if (!error && spawnError) error = 'crash';
      if (!error && f && !f.ok) error = 'model-error';
      if (!error && exitCode !== 0) error = (exitCode !== null ? p.exitCodes?.[exitCode] : undefined) ?? 'crash';
      if (error === 'crash' || error === 'model-error') {
        if (errors.some((e) => e.auth) || (p.authHint ?? AUTH_HINT).test(why)) error = 'auth';
        else if (errors.some((e) => e.quota) || QUOTA_HINT.test(why)) error = 'quota';
      }
      const ran = models.size ? [...models] : requested ? [requested] : [];
      const reported = p.reportsCost && (reportedCost > 0 || (f?.costUsd ?? 0) > 0);
      const costUsd = reported ? Math.round((f?.costUsd || reportedCost) * 1e6) / 1e6 : estimateCommandCost(p, usage);
      const numTurns = f?.numTurns ?? tools;
      const durationMs = Date.now() - started;
      const tail = [why, error === 'crash' && exitCode !== null && !spawnError ? `${p.name} stopped with exit code ${exitCode}.` : '', error === 'timeout' ? `${p.name} ran past its time limit and was stopped.` : '']
        .filter(Boolean)
        .join('\n');
      o.onEvent?.({
        kind: 'result',
        isError: Boolean(error),
        subtype: error ?? 'success',
        result: text,
        sessionId: f?.sessionId ?? '',
        numTurns,
        durationMs,
        costUsd,
        usage,
        models: ran,
      });
      resolveDone({
        ok: !error,
        ...(error ? { error } : {}),
        model: ran[0] ?? null,
        models: ran,
        sessionId: f?.sessionId ?? null,
        text,
        usage,
        costUsd,
        costEstimated: !reported,
        numTurns,
        durationMs,
        exitCode,
        stderrTail: tail.slice(-4096),
      });
    };
    child.on('error', (err) => {
      spawnError = `Could not start ${p.name}: ${err.message}`;
      finish(null);
    });
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

function safeUsage<T>(parse: (json: unknown) => T | null, json: unknown): T | null {
  try {
    return parse(json);
  } catch {
    return null;
  }
}

function safeParse(parse: (line: string) => CommandEvent[], line: string): CommandEvent[] {
  try {
    return parse(line);
  } catch {
    return [];
  }
}

export function refuseRun(reason: string): RunHandle {
  return {
    done: Promise.resolve({
      ok: false,
      error: 'crash',
      model: null,
      models: [],
      sessionId: null,
      text: '',
      usage: { ...EMPTY },
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
