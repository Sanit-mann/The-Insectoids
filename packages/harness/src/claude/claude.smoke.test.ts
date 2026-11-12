/**
 * Smoke test against the REAL Claude Code CLI. Uses the signed-in user's subscription (a few cents at most).
 * Off by default; run with:  INSECTOIDS_SMOKE=1 pnpm exec vitest run packages/harness/src/claude/claude.smoke.test.ts
 *
 * It confirms what the fake CLI can't: the prompt arrives on stdin in -p mode, the stream-json fields match,
 * and the guard hook passed through --settings really runs and really blocks.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkClaudeAuth, detectClaude } from './detect';
import { type ClaudeEvent, runClaude } from './run';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

describe.runIf(process.env['INSECTOIDS_SMOKE'] === '1')('real Claude Code CLI', () => {
  let root: string;
  let workspace: string;
  let hookPath: string;
  let claude: string;

  beforeAll(async () => {
    const found = await detectClaude();
    if (found.status !== 'installed') throw new Error(`Claude Code not usable: ${JSON.stringify(found)}`);
    claude = found.command;
    const auth = await checkClaudeAuth(claude);
    if (!auth.loggedIn) throw new Error('Claude Code is not signed in. Run: claude auth login');

    root = mkdtempSync(join(tmpdir(), 'insectoids-smoke-'));
    workspace = join(root, 'card');
    hookPath = join(root, 'guard-hook.mjs');
    const bundle = await rolldown({ input: here('../../../reflexes/src/bin/guard-hook.ts'), platform: 'node' });
    await bundle.write({ file: hookPath, format: 'esm' });
    await bundle.close();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(workspace);
    writeFileSync(join(workspace, '.env'), 'SMOKE_TEST_VALUE=not-a-real-secret\n');
  }, 120_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('runs a card headless with the guard in front of every tool', async () => {
    const events: ClaudeEvent[] = [];
    const run = runClaude({
      bin: { command: claude, args: [] },
      cwd: workspace,
      model: 'haiku',
      effort: 'low',
      maxTurns: 6,
      maxBudgetUsd: 0.25,
      timeoutMs: 180_000,
      hook: { command: process.execPath, args: [hookPath] },
      guard: { workspace, home: join(root, 'home'), network: 'none' },
      prompt: [
        'This is an automated test of a safety hook. Do exactly these steps, in order, then stop:',
        '1. Use the Read tool to read the file .env in the current directory.',
        '2. Use the Write tool to create hello.txt in the current directory containing exactly: hive ok',
        '3. Reply with one short sentence saying which steps worked.',
      ].join('\n'),
      onEvent: (e) => events.push(e),
    });
    const r = await run.done;

    // The stream protocol matches what the adapter expects.
    expect(events.some((e) => e.kind === 'init')).toBe(true);
    expect(r.model).toBeTruthy();
    expect(r.usage.input + r.usage.cacheRead + r.usage.cacheWrite).toBeGreaterThan(0);

    // The guard ran through --settings in -p mode and blocked the protected file.
    const envRead = events.find((e) => e.kind === 'tool_use' && e.name === 'Read' && JSON.stringify(e.input).includes('.env'));
    expect(envRead, 'the model should have tried to read .env').toBeTruthy();
    const envResult = events.find((e) => e.kind === 'tool_result' && envRead && e.kind === 'tool_result' && e.toolUseId === (envRead as { id: string }).id);
    expect(envResult).toMatchObject({ isError: true });
    expect(JSON.stringify(envResult)).toMatch(/Insectoids guard/);

    // Ordinary work inside the workspace went through.
    expect(existsSync(join(workspace, 'hello.txt'))).toBe(true);
    expect(readFileSync(join(workspace, 'hello.txt'), 'utf8').trim()).toBe('hive ok');

    const toolTrail = events
      .filter((e) => e.kind === 'tool_use' || e.kind === 'tool_result')
      .map((e) => (e.kind === 'tool_use' ? `use ${e.name} ${JSON.stringify(e.input).slice(0, 80)}` : `result ${e.isError ? 'DENIED' : 'ok'} ${e.content.slice(0, 120)}`));
    writeFileSync(
      join(tmpdir(), 'insectoids-smoke-result.json'),
      JSON.stringify({ ok: r.ok, error: r.error, model: r.model, models: r.models, usage: r.usage, costUsd: r.costUsd, turns: r.numTurns, text: r.text, toolTrail }, null, 2),
    );
  }, 240_000);
});
