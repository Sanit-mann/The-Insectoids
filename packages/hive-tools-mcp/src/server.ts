import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, globSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type HookPolicy, type Verdict, evaluateCommand, evaluatePath } from '@insectoids/reflexes';
import { z } from 'zod';

export const SERVER_NAME = 'insectoids-hive-tools';
export const SERVER_VERSION = '0.1.0';

/** Environment variables that must never reach a command an insect runs. */
export const STRIPPED_ENV = ['ELECTRON_RUN_AS_NODE', 'INSECTOIDS_GUARD', 'INSECTOIDS_BRAIN_TOKEN'] as const;

export interface HiveToolsOptions {
  /** Default: the policy's platform, else this machine's. */
  platform?: 'win32' | 'posix';
  /** Environment for commands (STRIPPED_ENV is always removed). Default: this process's. */
  env?: NodeJS.ProcessEnv;
  /** Largest text returned by one tool call. Default 30,000 characters. */
  maxOutput?: number;
  /** Default command timeout. Default 2 minutes; the model may ask for up to 10. */
  defaultTimeoutMs?: number;
}

/** Why there is no policy, when there is none: every tool refuses with this. */
export type PolicyResult = { policy: HookPolicy; error?: undefined } | { policy: null; error: string };

/** Reads the guard policy exactly as the hook does (INSECTOIDS_GUARD, JSON HookPolicy). */
export function policyFromEnv(env: NodeJS.ProcessEnv, realpath?: (p: string) => string): PolicyResult {
  try {
    const policy = JSON.parse(env['INSECTOIDS_GUARD'] ?? '') as HookPolicy;
    if (!policy || typeof policy.workspace !== 'string' || !policy.workspace || typeof policy.home !== 'string' || !policy.home) {
      throw new Error('incomplete');
    }
    return { policy: realpath ? { ...policy, workspace: realpath(policy.workspace), realpath } : policy };
  } catch {
    return { policy: null, error: 'The guard has no policy for this insect, so nothing is allowed.' };
  }
}

const MAX_TIMEOUT_MS = 10 * 60_000;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_LIST = 500;
const MAX_MATCHES = 200;
const MAX_SEARCH_FILE_BYTES = 1_000_000;

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });
const refuse = (t: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: t }] });

/** Same wording as the Claude Code hook, so insects get one consistent message whatever the engine. */
function verdictMessage(v: Exclude<Verdict, { decision: 'allow' }>): string {
  return v.decision === 'block'
    ? `Blocked by the Insectoids guard [${v.rule}]: ${v.reason}`
    : `Needs the user's approval [${v.rule}]: ${v.reason} Do not retry or work around this. End your work with "STATUS: BLOCKED: <what you need and why>"; the Queen will ask the user.`;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… (truncated: ${s.length - max} more characters; narrow the request)`;
}

function killTree(child: ChildProcess, win: boolean): void {
  if (child.pid === undefined) return;
  try {
    if (win) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * Guarded file and shell tools over MCP (Phase 2 A2). For engines whose own pre-tool hooks can't fail
 * closed (Gemini CLI), every built-in side-effect tool is denied by policy and the insect works through
 * these tools instead. The command guard runs here, before every action, and any error refuses it.
 */
export function createHiveToolsServer(policyOrResult: HookPolicy | PolicyResult | null, opts: HiveToolsOptions = {}): McpServer {
  const result: PolicyResult =
    policyOrResult && 'policy' in policyOrResult
      ? (policyOrResult as PolicyResult)
      : policyOrResult
        ? { policy: policyOrResult as HookPolicy }
        : { policy: null, error: 'The guard has no policy for this insect, so nothing is allowed.' };
  const policy = result.policy;
  const platform = opts.platform ?? policy?.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
  const win = platform === 'win32';
  const P = win ? path.win32 : path.posix;
  const max = opts.maxOutput ?? 30_000;
  const ctx: HookPolicy | null = policy ? { ...policy, platform } : null;
  const shellName = win ? 'PowerShell' : 'sh (POSIX shell)';

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: ctx
        ? [
            `The Insectoids hive tools: the only way to read, change files and run commands in this card's workspace (${ctx.workspace}).`,
            'Paths are relative to the workspace. Every action is checked by the hive\'s safety guard first.',
            `run_shell uses ${shellName}${win ? ': use PowerShell syntax (e.g. `;` to chain, `if ($?) { … }`), not bash' : ''}.`,
            'Leave your changes uncommitted; the hive commits them.',
          ].join('\n')
        : `The Insectoids hive tools are unavailable: ${result.error} Stop and end with "STATUS: BLOCKED: the hive's safety guard has no policy for this run".`,
    },
  );

  /** Wraps every tool: no policy refuses, any error refuses (fail closed). */
  const guarded = <A>(fn: (args: A, c: HookPolicy) => CallToolResult | Promise<CallToolResult>) => async (args: A): Promise<CallToolResult> => {
    if (!ctx) return refuse(result.error ?? 'No guard policy.');
    try {
      return await fn(args, ctx);
    } catch (err) {
      return refuse(`Refused: the hive tools hit an error (${err instanceof Error ? err.message : String(err)}). Nothing was done.`);
    }
  };

  const allowed = (v: Verdict, c: HookPolicy): v is { decision: 'allow' } =>
    v.decision === 'allow' || (v.decision === 'ask' && (c.approvedRules ?? []).includes(v.rule));

  /** Resolve a path inside the workspace and run the guard on it; returns the absolute path or a refusal. */
  const checkPath = (target: string, op: 'read' | 'write', c: HookPolicy): { abs: string } | { refusal: CallToolResult } => {
    const raw = target.trim() === '' ? '.' : target;
    const lexical = P.resolve(c.workspace, raw);
    const abs = c.realpath ? c.realpath(lexical) : lexical;
    const rel = P.relative(c.workspace, abs);
    if (rel === '..' || rel.startsWith(`..${P.sep}`) || P.isAbsolute(rel)) {
      return { refusal: refuse(`Blocked by the Insectoids guard [outside-workspace]: ${target} is outside this card's workspace; these tools only work inside it.`) };
    }
    const v = evaluatePath(raw, op, c);
    if (!allowed(v, c)) return { refusal: refuse(verdictMessage(v as Exclude<Verdict, { decision: 'allow' }>)) };
    return { abs };
  };
  const relOf = (abs: string, c: HookPolicy): string => P.relative(c.workspace, abs).split(P.sep).join('/') || '.';

  const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
  const WRITES = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

  server.registerTool(
    'read_file',
    {
      description: 'Read a text file in the workspace. Optional 1-based start line and line count for big files.',
      inputSchema: {
        path: z.string().describe('File path, relative to the workspace'),
        offset: z.number().int().min(1).optional().describe('First line to return (1-based)'),
        limit: z.number().int().min(1).max(5000).optional().describe('How many lines'),
      },
      annotations: READ_ONLY,
    },
    guarded((a: { path: string; offset?: number | undefined; limit?: number | undefined }, c) => {
      const r = checkPath(a.path, 'read', c);
      if ('refusal' in r) return r.refusal;
      if (!existsSync(r.abs) || !statSync(r.abs).isFile()) return refuse(`No file at ${a.path}.`);
      const lines = readFileSync(r.abs, 'utf8').split(/\r?\n/);
      const start = (a.offset ?? 1) - 1;
      const slice = lines.slice(start, a.limit ? start + a.limit : undefined);
      const header = a.offset || a.limit ? `${relOf(r.abs, c)} (lines ${start + 1}-${start + slice.length} of ${lines.length})\n` : '';
      return text(clip(header + slice.join('\n'), max));
    }),
  );

  server.registerTool(
    'list_dir',
    {
      description: 'List a folder in the workspace (folders end with /). Skips .git and node_modules.',
      inputSchema: { path: z.string().optional().describe('Folder, relative to the workspace (default: the workspace)') },
      annotations: READ_ONLY,
    },
    guarded((a: { path?: string | undefined }, c) => {
      const r = checkPath(a.path ?? '.', 'read', c);
      if ('refusal' in r) return r.refusal;
      if (!existsSync(r.abs) || !statSync(r.abs).isDirectory()) return refuse(`No folder at ${a.path ?? '.'}.`);
      const entries = readdirSync(r.abs, { withFileTypes: true })
        .filter((e) => !SKIP_DIRS.has(e.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      const shown = entries.slice(0, MAX_LIST);
      const more = entries.length > MAX_LIST ? `\n… ${entries.length - MAX_LIST} more` : '';
      return text(shown.length ? shown.join('\n') + more : '(empty folder)');
    }),
  );

  server.registerTool(
    'glob',
    {
      description: 'Find files by glob pattern (e.g. "src/**/*.ts"), relative to the workspace. Skips .git and node_modules.',
      inputSchema: { pattern: z.string().min(1).describe('Glob pattern') },
      annotations: READ_ONLY,
    },
    guarded((a: { pattern: string }, c) => {
      const base = checkPath('.', 'read', c);
      if ('refusal' in base) return base.refusal;
      if (P.isAbsolute(a.pattern) || a.pattern.split(/[\\/]/).includes('..')) {
        return refuse('Blocked by the Insectoids guard [outside-workspace]: glob patterns must stay inside the workspace (no absolute paths or ..).');
      }
      const hits = globSync(a.pattern, {
        cwd: base.abs,
        exclude: (p: string) => p.split(/[\\/]/).some((part) => SKIP_DIRS.has(part)),
      })
        .map((p) => p.split(/[\\/]/).join('/'))
        .filter((p) => evaluatePath(p, 'read', c).decision === 'allow')
        .sort();
      const shown = hits.slice(0, MAX_LIST);
      const more = hits.length > MAX_LIST ? `\n… ${hits.length - MAX_LIST} more` : '';
      return text(shown.length ? shown.join('\n') + more : 'No files match.');
    }),
  );

  server.registerTool(
    'search',
    {
      description: 'Search file contents in the workspace. Returns path:line: text, at most 200 matches. Protected files are skipped.',
      inputSchema: {
        pattern: z.string().min(1).describe('Regular expression (or plain text with literal: true)'),
        path: z.string().optional().describe('Folder or file to search (default: the workspace)'),
        literal: z.boolean().optional().describe('Treat the pattern as plain text'),
        ignoreCase: z.boolean().optional(),
      },
      annotations: READ_ONLY,
    },
    guarded((a: { pattern: string; path?: string | undefined; literal?: boolean | undefined; ignoreCase?: boolean | undefined }, c) => {
      const r = checkPath(a.path ?? '.', 'read', c);
      if ('refusal' in r) return r.refusal;
      let re: RegExp;
      try {
        re = new RegExp(a.literal ? a.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : a.pattern, a.ignoreCase ? 'i' : '');
      } catch (err) {
        return refuse(`Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`);
      }
      const matches: string[] = [];
      let skipped = 0;
      const visit = (abs: string): void => {
        if (matches.length >= MAX_MATCHES) return;
        const st = statSync(abs);
        if (st.isDirectory()) {
          for (const e of readdirSync(abs)) if (!SKIP_DIRS.has(e)) visit(P.join(abs, e));
          return;
        }
        if (!st.isFile() || st.size > MAX_SEARCH_FILE_BYTES) return;
        const rel = relOf(abs, c);
        if (evaluatePath(rel, 'read', c).decision !== 'allow') {
          skipped++;
          return;
        }
        const body = readFileSync(abs, 'utf8');
        if (body.includes('\u0000')) return; // binary
        const lines = body.split(/\r?\n/);
        for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
          if (re.test(lines[i]!)) matches.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
        }
      };
      visit(r.abs);
      const notes = [
        matches.length >= MAX_MATCHES ? `(stopped at ${MAX_MATCHES} matches; narrow the search)` : '',
        skipped ? `(${skipped} protected file(s) skipped)` : '',
      ].filter(Boolean);
      return text(clip([matches.length ? matches.join('\n') : 'No matches.', ...notes].join('\n'), max));
    }),
  );

  server.registerTool(
    'write_file',
    {
      description: 'Create or overwrite a file in the workspace (folders are created). Prefer edit_file for small changes.',
      inputSchema: { path: z.string().min(1), content: z.string() },
      annotations: WRITES,
    },
    guarded((a: { path: string; content: string }, c) => {
      const r = checkPath(a.path, 'write', c);
      if ('refusal' in r) return r.refusal;
      // Plain words for the two ways a path can't take a file (a small model got stuck on a bare EEXIST, C6 demo).
      if (existsSync(r.abs) && statSync(r.abs).isDirectory()) return refuse(`${a.path} is a folder, not a file. Pick a file name inside it.`);
      for (let dir = P.dirname(r.abs); dir.length >= c.workspace.length && dir !== P.dirname(dir); dir = P.dirname(dir)) {
        if (existsSync(dir) && !statSync(dir).isDirectory()) {
          return refuse(`${relOf(dir, c)} is a file, so nothing can be written inside it as a folder. Write to another path, or remove that file first if a folder belongs there.`);
        }
      }
      mkdirSync(P.dirname(r.abs), { recursive: true });
      writeFileSync(r.abs, a.content);
      return text(`Wrote ${relOf(r.abs, c)} (${Buffer.byteLength(a.content)} bytes).`);
    }),
  );

  server.registerTool(
    'edit_file',
    {
      description: 'Replace exact text in a file. old_string must match exactly once, unless replace_all is true.',
      inputSchema: {
        path: z.string().min(1),
        old_string: z.string().min(1),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      },
      annotations: WRITES,
    },
    guarded((a: { path: string; old_string: string; new_string: string; replace_all?: boolean | undefined }, c) => {
      const r = checkPath(a.path, 'write', c);
      if ('refusal' in r) return r.refusal;
      if (!existsSync(r.abs) || !statSync(r.abs).isFile()) return refuse(`No file at ${a.path}.`);
      const body = readFileSync(r.abs, 'utf8');
      const count = body.split(a.old_string).length - 1;
      if (count === 0) return refuse(`old_string was not found in ${a.path}. Read the file and copy the text exactly.`);
      if (count > 1 && !a.replace_all) return refuse(`old_string matches ${count} times in ${a.path}. Add surrounding text to make it unique, or set replace_all.`);
      writeFileSync(r.abs, a.replace_all ? body.split(a.old_string).join(a.new_string) : body.replace(a.old_string, () => a.new_string));
      return text(`Edited ${relOf(r.abs, c)} (${a.replace_all ? count : 1} replacement${(a.replace_all ? count : 1) === 1 ? '' : 's'}).`);
    }),
  );

  server.registerTool(
    'run_shell',
    {
      description: win
        ? 'Run a PowerShell command in the workspace (use PowerShell syntax, not bash). Returns exit code, stdout and stderr. Default timeout 2 min, max 10.'
        : 'Run a sh command in the workspace. Returns exit code, stdout and stderr. Default timeout 2 min, max 10.',
      inputSchema: {
        command: z.string().min(1),
        timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guarded(async (a: { command: string; timeout_ms?: number | undefined }, c) => {
      const v = evaluateCommand(a.command, c);
      if (!allowed(v, c)) return refuse(verdictMessage(v as Exclude<Verdict, { decision: 'allow' }>));
      const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };
      for (const k of STRIPPED_ENV) delete env[k];
      const [cmd, args] = win
        ? // -Command turns any failing program's exit code into 1; hand the program's own code back.
          ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${a.command}\nif ($LASTEXITCODE) { exit $LASTEXITCODE }`]]
        : ['/bin/sh', ['-c', a.command]];
      const timeout = a.timeout_ms ?? opts.defaultTimeoutMs ?? 120_000;
      return await new Promise<CallToolResult>((resolve) => {
        const child = spawn(cmd, args, { cwd: c.workspace, env, windowsHide: true, detached: !win, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        let timedOut = false;
        child.stdout.setEncoding('utf8').on('data', (d: string) => {
          if (out.length < max * 2) out += d;
        });
        child.stderr.setEncoding('utf8').on('data', (d: string) => {
          if (err.length < max * 2) err += d;
        });
        const timer = setTimeout(() => {
          timedOut = true;
          killTree(child, win);
        }, timeout);
        child.on('error', (e) => {
          clearTimeout(timer);
          resolve(refuse(`Could not start ${shellName}: ${e.message}`));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          const half = Math.floor(max / 2);
          const parts = [
            timedOut ? `Timed out after ${timeout} ms; the command and everything it started were stopped.` : `Exit code ${code ?? 'unknown'}`,
            out ? `--- stdout ---\n${clip(out, half)}` : '',
            err ? `--- stderr ---\n${clip(err, half)}` : '',
          ].filter(Boolean);
          // A non-zero exit (e.g. failing tests) is a normal result the insect reads; only a timeout is an error.
          resolve(timedOut ? { isError: true, content: [{ type: 'text', text: parts.join('\n') }] } : text(parts.join('\n')));
        });
      });
    }),
  );

  return server;
}
