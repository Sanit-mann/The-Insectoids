import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildClaudeArgs, buildHookSettings } from './args';
import { MIN_CLAUDE_VERSION, checkClaudeAuth, detectClaude, isSupportedVersion, parseVersion } from './detect';
import { type ClaudeEvent, runClaude } from './run';
import { parseStreamLine } from './stream';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const fake = { command: process.execPath, args: [here('./fake-claude.mjs')] };
let tmp: string;
let hookPath: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'insectoids-claude-'));
  hookPath = join(tmp, 'guard-hook.mjs');
  const bundle = await rolldown({ input: here('../../../reflexes/src/bin/guard-hook.ts'), platform: 'node' });
  await bundle.write({ file: hookPath, format: 'esm' });
  await bundle.close();
}, 60_000);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('command line for a card', () => {
  it('builds headless args with model, effort, limits and the guard', () => {
    const args = buildClaudeArgs({
      model: 'sonnet',
      effort: 'medium',
      settings: { hooks: {} },
      maxTurns: 40,
      maxBudgetUsd: 2,
      systemPromptFile: '/hive/brief.md',
    });
    expect(args).toEqual([
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'dontAsk',
      '--setting-sources', 'project,local',
      '--no-session-persistence',
      '--settings', '{"hooks":{}}',
      '--model', 'sonnet',
      '--effort', 'medium',
      '--max-turns', '40',
      '--max-budget-usd', '2',
      '--append-system-prompt-file', '/hive/brief.md',
    ]);
  });

  it('registers the guard on every tool, and makes a failed hook block (never allow)', () => {
    const s = buildHookSettings({ command: 'node', args: ['/x/guard-hook.mjs'] });
    expect(s).toEqual({
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node', args: ['/x/guard-hook.mjs'], timeout: 30, onFailure: 'block' }] }],
      },
    });
  });
});

describe('reading the event stream', () => {
  it('turns stream-json lines into events and ignores noise', () => {
    expect(parseStreamLine('not json')).toEqual([]);
    expect(parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm' }))).toEqual([{ kind: 'init', sessionId: 's', model: 'm' }]);
    expect(
      parseStreamLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } })),
    ).toEqual([
      { kind: 'text', text: 'hi' },
      { kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    ]);
  });

  it('reads the version the CLI prints', () => {
    expect(parseVersion('2.1.211 (Claude Code)\n')).toBe('2.1.211');
    expect(parseVersion('garbage')).toBeNull();
  });

  it('requires a CLI new enough for onFailure: block (2.1.295+)', () => {
    expect(MIN_CLAUDE_VERSION).toBe('2.1.295');
    expect(isSupportedVersion('2.1.295')).toBe(true);
    expect(isSupportedVersion('2.1.322')).toBe(true);
    expect(isSupportedVersion('2.2.0')).toBe(true);
    expect(isSupportedVersion('3.0.0')).toBe(true);
    expect(isSupportedVersion('2.1.294')).toBe(false);
    expect(isSupportedVersion('2.0.999')).toBe(false);
    expect(isSupportedVersion('1.9.9')).toBe(false);
  });

  it('reads sign-in state from `claude auth status`', async () => {
    const out = JSON.stringify({ loggedIn: false, authMethod: 'none', loginExpiresAt: null });
    expect(await checkClaudeAuth('claude', { run: async () => out })).toEqual({ loggedIn: false, method: 'none', expiresAt: null });
    const inOut = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', loginExpiresAt: '2026-12-01T00:00:00Z' });
    expect(await checkClaudeAuth('claude', { run: async () => inOut })).toMatchObject({ loggedIn: true, method: 'claude.ai' });
    expect(await checkClaudeAuth('claude', { run: async () => 'not json' })).toMatchObject({ loggedIn: false });
  });

  it('reports an outdated CLI instead of using it', async () => {
    const old = await detectClaude({ PATH: '' }, { run: async () => '2.1.200 (Claude Code)', exists: () => true });
    expect(old).toMatchObject({ status: 'outdated', version: '2.1.200' });
    const ok = await detectClaude({ PATH: '' }, { run: async () => '2.1.322 (Claude Code)', exists: () => true });
    expect(ok).toMatchObject({ status: 'installed', version: '2.1.322' });
  });
});

describe('running a card against the CLI (fake)', () => {
  const run = (prompt: string, extra: Partial<Parameters<typeof runClaude>[0]> = {}) => {
    const events: ClaudeEvent[] = [];
    const handle = runClaude({
      bin: fake,
      cwd: tmp,
      prompt,
      model: 'sonnet',
      effort: 'low',
      hook: { command: process.execPath, args: [hookPath] },
      guard: { workspace: tmp, home: join(tmp, 'home'), network: 'none' },
      onEvent: (e) => events.push(e),
      ...extra,
    });
    return { handle, events };
  };

  it('streams text and reports the model that actually ran, tokens and cost', async () => {
    const { handle, events } = run('SAY Pricing page built.');
    const r = await handle.done;
    expect(r).toMatchObject({ ok: true, model: 'sonnet', costUsd: 0.0123, numTurns: 2 });
    expect(r.usage).toEqual({ input: 120, output: 30, cacheRead: 400, cacheWrite: 50 });
    expect(events.some((e) => e.kind === 'text' && e.text === 'Pricing page built.')).toBe(true);
  });

  it('the real guard blocks a dangerous tool call made by the model', async () => {
    const { handle, events } = run(`TOOL Bash {"command":"rm -rf ${join(tmp, '..').replace(/\\/g, '/')}"}`);
    await handle.done;
    const result = events.find((e) => e.kind === 'tool_result');
    expect(result).toMatchObject({ kind: 'tool_result', isError: true });
    expect(result && 'content' in result && result.content).toMatch(/Insectoids guard/);
  });

  it('lets ordinary work through', async () => {
    const { handle, events } = run('TOOL Bash {"command":"npm test"}');
    await handle.done;
    expect(events.find((e) => e.kind === 'tool_result')).toMatchObject({ isError: false });
  });

  it('recognises a signed-out CLI', async () => {
    const r = await run('AUTHFAIL').handle.done;
    expect(r).toMatchObject({ ok: false, error: 'auth' });
  });

  it('stops a card that runs past its time limit', async () => {
    const r = await run('HANG', { timeoutMs: 800 }).handle.done;
    expect(r).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('can be stopped on demand (Watchdog breaker)', async () => {
    const { handle } = run('HANG');
    setTimeout(() => handle.stop(), 300);
    expect(await handle.done).toMatchObject({ ok: false, error: 'stopped' });
  });
});
