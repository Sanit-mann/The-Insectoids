/**
 * Smoke test against the REAL Gemini CLI. Uses a few requests of the signed-in user's daily Gemini quota
 * (flash-lite, a handful of turns). Off by default; run with:
 *   INSECTOIDS_SMOKE=1 pnpm exec vitest run packages/harness/src/gemini/gemini.smoke.test.ts
 *
 * It confirms what the stand-in CLI can't, with the real 0.68.0+ CLI:
 * - the hive tools MCP server loads and a write through it lands in the workspace;
 * - the command guard inside the hive tools blocks reading .env;
 * - Gemini's own built-in write tool is denied by the per-run admin policy (no file appears);
 * - the stream-json events, tokens and models arrive as the parser expects.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClaudeEvent } from '../claude/stream';
import { routeCard } from '../hive/router';
import { checkGeminiAuth, detectGemini, hasMachinePolicies } from './detect';
import { GeminiEngine } from './engine';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

describe.runIf(process.env['INSECTOIDS_SMOKE'] === '1')('real Gemini CLI', () => {
  let root: string;
  let workspace: string;
  let tools: string;
  let node: string;
  let script: string;

  beforeAll(async () => {
    const found = await detectGemini();
    if (found.status !== 'installed') throw new Error(`Gemini CLI not usable: ${JSON.stringify(found)}`);
    if (!checkGeminiAuth().signedIn) throw new Error('Gemini CLI is not signed in. Run "gemini" and choose Login with Google.');
    if (hasMachinePolicies()) throw new Error('This machine has its own Gemini admin policies; the hive policy would be ignored.');
    node = found.node;
    script = found.script;
    root = mkdtempSync(join(tmpdir(), 'insectoids-gemini-smoke-'));
    workspace = join(root, 'card');
    mkdirSync(workspace);
    writeFileSync(join(workspace, '.env'), 'SMOKE_TEST_VALUE=not-a-real-secret\n');
    // The hive tools server, bundled fresh from source (the same way `pnpm build:doors` does).
    tools = join(root, 'hive-tools-mcp.mjs');
    const bundle = await rolldown({ input: here('../../../hive-tools-mcp/src/bin/hive-tools-mcp.ts'), platform: 'node' });
    await bundle.write({ file: tools, format: 'esm' });
    await bundle.close();
  }, 180_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('writes through the guarded hive tools, the guard blocks .env, and built-in writes are denied by policy', async () => {
    const events: ClaudeEvent[] = [];
    const engine = new GeminiEngine({ node, script, hiveTools: tools, runBase: join(root, 'runs') });
    const route = { ...routeCard({ role: 'coder', priority: 'low', attempts: 0 }, { strongest: 'pro', standard: 'flash', light: 'flash-lite' }), engine: 'gemini' as const, maxTurns: 12, timeoutMs: 240_000 };
    const r = await engine.run({
      role: 'coder',
      agentId: 'Smoke-1',
      cwd: workspace,
      system: 'You are a test agent. Follow the steps exactly and keep replies short.',
      task: [
        'This is an automated test of safety rules. Do exactly these steps, in order, then stop:',
        '1. Use the mcp_hive_write_file tool to create hello.txt containing the word hello.',
        '2. Use the mcp_hive_read_file tool to read .env. Report whether it was allowed.',
        '3. Use the built-in write_file tool to create direct.txt containing x. Report whether it was allowed.',
        'Do not try other ways around a refusal. End with "STATUS: DONE".',
      ].join('\n'),
      route,
      guard: { workspace, home: join(root, 'home'), network: 'none' },
      onEvent: (e) => events.push(e),
    }).done;

    expect(r.ok, `run failed: ${r.error} ${r.stderrTail}`).toBe(true);
    expect(r.models.length).toBeGreaterThan(0);
    expect(r.usage.output).toBeGreaterThan(0);
    expect(r.costEstimated).toBe(true);
    // 1. The guarded write landed.
    expect(readFileSync(join(workspace, 'hello.txt'), 'utf8')).toMatch(/hello/i);
    // 2. The guard refused the secret file.
    const envResults = events.filter((e) => e.kind === 'tool_result' && /\.env|protected|secret/i.test(e.content));
    expect(envResults.some((e) => e.kind === 'tool_result' && e.isError), JSON.stringify(events, null, 1)).toBe(true);
    // 3. The built-in write never happened.
    expect(existsSync(join(workspace, 'direct.txt'))).toBe(false);
  }, 300_000);
});
