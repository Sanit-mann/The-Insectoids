import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineRequest } from '../hive/engine';
import { COPILOT_PRESET } from './copilot';
import { CommandEngine } from './engine';

/**
 * The real Copilot CLI through the hive's engine, with the real hive tools and guard, but offline: Copilot's
 * documented BYOK mode (COPILOT_OFFLINE + a provider URL) points it at a scripted fake model here, so no
 * GitHub account is used and nothing is spent. Opt-in: set INSECTOIDS_COPILOT_BIN to the native copilot
 * program (e.g. …\npm\node_modules\@github\copilot\node_modules\@github\copilot-win32-x64\copilot.exe).
 */
const BIN = process.env['INSECTOIDS_COPILOT_BIN'];
const HIVE_TOOLS = fileURLToPath(new URL('../../../hive-tools-mcp/dist/hive-tools-mcp.mjs', import.meta.url));

type Msg = { role: string; content?: unknown };
type Call = { name: string; args: Record<string, string> };
// The fake model's script: one tool call per turn, then a final answer.
const SCRIPT: Call[] = [
  { name: 'hive-write_file', args: { path: 'hello.txt', content: 'hi from copilot' } },
  // Copilot's own shell is hidden from the model; a model that calls it anyway must get nowhere.
  { name: 'powershell', args: { command: 'echo pwned > pwned.txt', description: 'x' } },
  // The hive tools' guard keeps writes inside the workspace.
  { name: 'hive-write_file', args: { path: '../escape.txt', content: 'out' } },
];

describe.skipIf(!BIN)('Copilot CLI, offline against a fake model (opt-in)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'insectoids copilot offline '));
  const offered: string[][] = [];
  const results: string[] = [];
  let server: Server;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const j = JSON.parse(body || '{}') as { tools?: Array<{ function?: { name?: string } }>; messages?: Msg[] };
        offered.push((j.tools ?? []).map((t) => t.function?.name ?? ''));
        const toolMsgs = (j.messages ?? []).filter((m) => m.role === 'tool');
        const last = toolMsgs.at(-1);
        if (last) results.push(typeof last.content === 'string' ? last.content : JSON.stringify(last.content));
        const step = SCRIPT[toolMsgs.length];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (o: unknown): boolean => res.write(`data: ${JSON.stringify(o)}\n\n`);
        const base = { id: `c${offered.length}`, object: 'chat.completion.chunk', created: 1, model: 'fake-model' };
        if (step) {
          send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${toolMsgs.length}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] }, finish_reason: null }] });
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
        } else {
          send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Wrote hello.txt.\nSTATUS: DONE' }, finish_reason: null }] });
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127 } });
        }
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const env = { COPILOT_OFFLINE: 'true', COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${port}/v1`, COPILOT_HOME: join(tmp, 'home'), COPILOT_ALLOW_ALL: 'true' };
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    server?.close();
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  });

  it('works only through the hive tools: writes inside the workspace, Copilot’s own shell and escapes go nowhere', async () => {
    const cwd = join(tmp, 'project', 'work');
    mkdirSync(cwd, { recursive: true });
    const runBase = join(tmp, 'runs');
    const engine = new CommandEngine({ preset: COPILOT_PRESET, bin: { command: BIN!, args: [] }, hiveTools: HIVE_TOOLS, runtime: { command: process.execPath }, runBase });
    const req: EngineRequest = {
      role: 'coder',
      agentId: 'Ant-01',
      cwd,
      system: 'You are a worker ant.',
      task: 'Write hello.txt.',
      route: { engine: 'copilot', tier: 'standard', model: 'fake-model', effort: 'medium', reason: 'rule: test', maxTurns: 10, maxBudgetUsd: 1, timeoutMs: 120_000 },
      guard: { workspace: cwd, home: tmp, noGo: [], network: 'none' },
    };
    const r = await engine.run(req).done;

    expect(r).toMatchObject({ ok: true, text: expect.stringContaining('STATUS: DONE') });
    expect(readFileSync(join(cwd, 'hello.txt'), 'utf8')).toBe('hi from copilot');
    expect(existsSync(join(cwd, 'pwned.txt'))).toBe(false);
    expect(existsSync(join(tmp, 'project', 'escape.txt'))).toBe(false);
    // The model was offered exactly the hive tools, never Copilot's own.
    expect(offered[0]).toEqual(expect.arrayContaining(['hive-write_file', 'hive-run_shell']));
    expect(offered[0]!.every((t) => t.startsWith('hive-'))).toBe(true);
    expect(results[1]).toMatch(/does not exist|denied/i);
    expect(results[2]).toMatch(/outside|refus|not allowed/i);
    // Token counts from Copilot's usage file; the run folder is gone.
    expect(r.usage.input).toBeGreaterThan(0);
    expect(r.models).toEqual(['fake-model']);
    expect(existsSync(runBase) ? readdirSync(runBase) : []).toEqual([]);
  }, 150_000);
});
