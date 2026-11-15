import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineRequest } from '../hive/engine';
import { CODEX_PRESET } from './codex';
import { CommandEngine } from './engine';

/**
 * The real Codex CLI through the hive's engine, with the real hive tools and guard, but offline: Codex's
 * custom model provider points at a scripted fake Responses API here, so no ChatGPT account is used and
 * nothing is spent. Opt-in: set INSECTOIDS_CODEX_BIN to the native codex program
 * (…\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe).
 */
const BIN = process.env['INSECTOIDS_CODEX_BIN'];
const HIVE_TOOLS = fileURLToPath(new URL('../../../hive-tools-mcp/dist/hive-tools-mcp.mjs', import.meta.url));

type Step = { name: string; namespace?: string; args?: Record<string, unknown>; custom?: string };
const SCRIPT: Step[] = [
  { name: 'write_file', namespace: 'mcp__hive', args: { path: 'hello.txt', content: 'hi from codex' } },
  // Codex's own tools are switched off; a model that calls them anyway must get nowhere.
  { name: 'exec_command', args: { cmd: 'echo pwned > pwned1.txt' } },
  { name: 'apply_patch', custom: '*** Begin Patch\n*** Add File: pwned2.txt\n+pwned\n*** End Patch\n' },
  // The hive tools' guard keeps writes inside the workspace.
  { name: 'write_file', namespace: 'mcp__hive', args: { path: '../escape.txt', content: 'out' } },
];

describe.skipIf(!BIN)('Codex CLI, offline against a fake model (opt-in)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'insectoids codex offline '));
  const offered: string[][] = [];
  const outputs: string[] = [];
  let server: Server;
  let port = 0;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const j = JSON.parse(body || '{}') as { tools?: Array<{ name?: string; type?: string; tools?: Array<{ name: string }> }>; input?: Array<{ type: string; output?: unknown }> };
        offered.push((j.tools ?? []).flatMap((t) => (t.type === 'namespace' ? (t.tools ?? []).map((x) => `${t.name}.${x.name}`) : [t.name ?? t.type ?? ''])));
        const done = (j.input ?? []).filter((i) => /_output$/.test(i.type));
        const last = done.at(-1);
        if (last) outputs.push(typeof last.output === 'string' ? last.output : JSON.stringify(last.output));
        const step = SCRIPT[done.length];
        const n = offered.length;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const ev = (o: { type: string } & Record<string, unknown>): boolean => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
        ev({ type: 'response.created', response: { id: `r${n}` } });
        const item = !step
          ? { type: 'message', id: `m${n}`, role: 'assistant', content: [{ type: 'output_text', text: 'Wrote hello.txt.\nSTATUS: DONE', annotations: [] }] }
          : step.custom !== undefined
            ? { type: 'custom_tool_call', id: `ct${n}`, call_id: `call_${n}`, name: step.name, input: step.custom }
            : { type: 'function_call', id: `fc${n}`, call_id: `call_${n}`, name: step.name, ...(step.namespace ? { namespace: step.namespace } : {}), arguments: JSON.stringify(step.args ?? {}) };
        ev({ type: 'response.output_item.done', output_index: 0, item });
        ev({ type: 'response.completed', response: { id: `r${n}`, usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 1020 } } });
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
    const home = join(tmp, 'codex-home');
    mkdirSync(home, { recursive: true });
    saved['CODEX_HOME'] = process.env['CODEX_HOME'];
    process.env['CODEX_HOME'] = home;
  });
  afterAll(() => {
    if (saved['CODEX_HOME'] === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = saved['CODEX_HOME'];
    server?.close();
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  });

  it('works only through the hive tools: writes inside the workspace; its own shell, patches and escapes go nowhere', async () => {
    const cwd = join(tmp, 'project', 'work');
    mkdirSync(cwd, { recursive: true });
    const runBase = join(tmp, 'runs');
    // The real preset, plus the fake model provider (test only).
    const preset = {
      ...CODEX_PRESET,
      headlessArgs: [
        ...CODEX_PRESET.headlessArgs,
        '-c', 'model_provider="fake"', '-c', 'model_providers.fake.name="fake"',
        '-c', `model_providers.fake.base_url="http://127.0.0.1:${port}/v1"`, '-c', 'model_providers.fake.wire_api="responses"',
        '-m', 'fake-model',
      ],
    };
    const engine = new CommandEngine({ preset, bin: { command: BIN!, args: [] }, hiveTools: HIVE_TOOLS, runtime: { command: process.execPath }, runBase });
    const req: EngineRequest = {
      role: 'coder',
      agentId: 'Ant-01',
      cwd,
      system: 'You are a worker ant.',
      task: 'Write hello.txt.',
      route: { engine: 'codex', tier: 'standard', model: 'default', effort: 'medium', reason: 'rule: test', maxTurns: 10, maxBudgetUsd: 1, timeoutMs: 150_000 },
      guard: { workspace: cwd, home: tmp, noGo: [], network: 'none' },
    };
    const r = await engine.run(req).done;

    expect(r, r.stderrTail).toMatchObject({ ok: true, text: expect.stringContaining('STATUS: DONE') });
    expect(readFileSync(join(cwd, 'hello.txt'), 'utf8')).toBe('hi from codex');
    expect(existsSync(join(cwd, 'pwned1.txt'))).toBe(false);
    expect(existsSync(join(cwd, 'pwned2.txt'))).toBe(false);
    expect(existsSync(join(tmp, 'project', 'escape.txt'))).toBe(false);
    // Only the hive's tools (and Codex's MCP-resource readers and question tool) were offered.
    expect(offered[0]).toEqual(expect.arrayContaining(['mcp__hive.write_file', 'mcp__hive.run_shell']));
    expect(offered[0]!.filter((t) => !t.startsWith('mcp__hive.')).sort()).toEqual(['list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource', 'request_user_input']);
    expect(outputs[1]).toMatch(/unsupported call: exec_command/);
    expect(outputs[2]).toMatch(/unsupported custom tool call: apply_patch/);
    expect(outputs[3]).toMatch(/outside|refus|not allowed/i);
    expect(r.usage).toMatchObject({ input: 4000, cacheRead: 1000, output: 100 });
    expect(existsSync(runBase) ? readdirSync(runBase) : []).toEqual([]);
  }, 180_000);
});
