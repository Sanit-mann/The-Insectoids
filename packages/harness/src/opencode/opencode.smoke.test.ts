/**
 * Smoke test against a REAL OpenCode 2.2.6+ install and a REAL OpenAI-compatible model server.
 * Off by default. It needs OpenCode installed (npm `@opencode/cli`) and a model server; a local one
 * (Ollama or LM Studio) costs nothing and keeps everything on this computer:
 *
 *   INSECTOIDS_SMOKE=1 OPENCODE_SMOKE_MODEL=qwen3:8b pnpm exec vitest run packages/harness/src/opencode/opencode.smoke.test.ts
 *
 * Optional: OPENCODE_SMOKE_BASE (default http://127.0.0.1:11434/v1, Ollama). The model must support tools.
 * It talks to the model server directly with a placeholder pass (no broker, no key): for a remote provider,
 * use the app's own API providers tab instead, so the key stays in the Vault.
 *
 * It confirms what the stand-in can't:
 * - the per-run config loads (deny-all, our agent, our provider, our MCP servers only);
 * - the only tools the model sees are the hive's (`hive_*`), and a write through them lands in the workspace;
 * - the guard inside the hive tools blocks reading .env;
 * - the JSON events, tokens and steps arrive as the parser expects.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClaudeEvent } from '../claude/stream';
import { mcpEnvironment } from './config';
import { blockingSystemConfig, detectOpenCode } from './detect';
import { runOpenCode } from './run';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const MODEL = process.env['OPENCODE_SMOKE_MODEL'] ?? '';
const BASE = process.env['OPENCODE_SMOKE_BASE'] ?? 'http://127.0.0.1:11434/v1';

describe.runIf(process.env['INSECTOIDS_SMOKE'] === '1')('real OpenCode', () => {
  let root: string;
  let workspace: string;
  let tools: string;
  let command: string;

  beforeAll(async () => {
    if (!MODEL) throw new Error('Set OPENCODE_SMOKE_MODEL to a tool-capable model on your model server.');
    const found = await detectOpenCode();
    if (found.status !== 'installed') throw new Error(`OpenCode not usable: ${JSON.stringify(found)}`);
    const blocking = blockingSystemConfig();
    if (blocking) throw new Error(`This machine has a machine-wide OpenCode config (${blocking}); the hive config would be overridden.`);
    command = found.command;
    root = mkdtempSync(join(tmpdir(), 'insectoids-opencode-smoke-'));
    workspace = join(root, 'card');
    mkdirSync(workspace);
    writeFileSync(join(workspace, '.env'), 'SECRET=do-not-read\n');
    tools = join(root, 'hive-tools-mcp.mjs');
    const bundle = await rolldown({ input: here('../../../hive-tools-mcp/src/bin/hive-tools-mcp.ts'), platform: 'node' });
    await bundle.write({ file: tools, format: 'esm' });
    await bundle.close();
  }, 120_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it('runs a card through the hive tools only; the guard blocks .env', async () => {
    const events: ClaudeEvent[] = [];
    const guard = { workspace, home: root, noGo: [], network: 'none', platform: process.platform === 'win32' ? 'win32' : 'posix' };
    const r = await runOpenCode({
      command,
      cwd: workspace,
      prompt: [
        'You are testing your tools. Do exactly this, then stop:',
        '1. Write a file named hello.txt containing the word hello, using your write tool.',
        '2. Try to read the file .env and report what happened.',
        '3. List the names of every tool you have.',
        'End with a line "STATUS: DONE".',
      ].join('\n'),
      title: 'Smoke test',
      model: MODEL,
      tiers: { strongest: MODEL, standard: MODEL, light: MODEL },
      baseUrl: BASE,
      pass: 'local-no-key',
      local: true,
      mcpServers: {
        hive: {
          command: [process.execPath, tools],
          environment: mcpEnvironment({ INSECTOIDS_GUARD: JSON.stringify(guard) }, process.env['ProgramData']),
          cwd: workspace,
        },
      },
      readOnly: false,
      maxSteps: 12,
      timeoutMs: 10 * 60_000,
      runDir: join(root, 'run'),
      onEvent: (e) => events.push(e),
    }).done;

    const toolNames = events.filter((e): e is Extract<ClaudeEvent, { kind: 'tool_use' }> => e.kind === 'tool_use').map((e) => e.name);
    // Every tool the model used is one of the hive's.
    expect(toolNames.length).toBeGreaterThan(0);
    expect(toolNames.every((n) => n.startsWith('hive_'))).toBe(true);
    expect(existsSync(join(workspace, 'hello.txt'))).toBe(true);
    expect(readFileSync(join(workspace, 'hello.txt'), 'utf8')).toMatch(/hello/i);
    const results = events.filter((e): e is Extract<ClaudeEvent, { kind: 'tool_result' }> => e.kind === 'tool_result');
    expect(results.some((e) => /\.env|protected/i.test(e.content) && /block|refus|not allowed|protected/i.test(e.content))).toBe(true);
    expect(results.every((e) => !e.content.includes('do-not-read'))).toBe(true);
    expect(r.usage.input).toBeGreaterThan(0);
    expect(r.ok, r.stderrTail).toBe(true);
  }, 12 * 60_000);
});
