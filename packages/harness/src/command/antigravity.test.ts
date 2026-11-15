import { describe, expect, it } from 'vitest';
import { commandAdapter } from './adapter';
import { ANTIGRAVITY_PRESET, parseAntigravityLine } from './antigravity';
import { buildCommandInvocation } from './args';
import { isForbiddenArg, unguardedReason } from './preset';

describe('Antigravity CLI (Phase 4 B4)', () => {
  it('can’t be guarded yet, and says why in plain words', () => {
    const why = unguardedReason(ANTIGRAVITY_PRESET);
    expect(why).toMatch(/^Antigravity CLI can't be guarded yet; it will run inside a container once container mode exists\. /);
    expect(why).toMatch(/global settings files/);
    expect(ANTIGRAVITY_PRESET.guard).toBeNull();
    expect(ANTIGRAVITY_PRESET.tested).toBe(false);
  });

  it('is listed with its real install and sign-in, and never detected or run', () => {
    const a = commandAdapter(ANTIGRAVITY_PRESET, { hiveTools: 'hive-tools.mjs', runtime: { command: 'electron.exe' }, runBase: 'C:\\runs' });
    expect(a.detect).toBeUndefined();
    expect(a.capabilities).toMatchObject({ guard: null, mcp: false, subscription: true, reportsCost: false, effort: ['low', 'medium', 'high', 'max'] });
    expect(a.unavailableReason).toMatch(/Antigravity CLI can't be guarded yet/);
    expect(a.install?.command).toBe('irm https://antigravity.google/cli/install.ps1 | iex');
    expect(a.signIn).toMatchObject({ command: 'agy', note: expect.stringMatching(/The hive never sees your login\./) });
    expect(() => buildCommandInvocation(ANTIGRAVITY_PRESET, { prompt: 'x', model: null, mcpServers: {}, readOnly: true, runDir: 'C:\\runs\\1' })).toThrow(/can't be guarded yet/);
  });

  it('its headless flags approve nothing; the approve-all flag and auto modes are forbidden', () => {
    for (const a of ANTIGRAVITY_PRESET.headlessArgs) expect(isForbiddenArg(a, ANTIGRAVITY_PRESET.forbiddenArgs)).toBe(false);
    for (const f of ['--dangerously-skip-permissions', '--mode', '--mode=auto', '--remote-agent']) expect(isForbiddenArg(f, ANTIGRAVITY_PRESET.forbiddenArgs)).toBe(true);
  });

  it('reads stream-json events in the documented shape (never seen from the real CLI)', () => {
    expect(parseAntigravityLine('{"event":"init","conversation_id":"c1","init":{"cwd":"C:\\\\w","tools":["read_file"],"permission_mode":"default"}}')).toEqual([]);
    // Tool steps count once, when done.
    expect(parseAntigravityLine('{"event":"step_update","step_update":{"conversation_id":"c1","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"read_file"}}')).toEqual([]);
    expect(parseAntigravityLine('{"event":"step_update","step_update":{"conversation_id":"c1","step_index":2,"state":"DONE","step_type":"tool","tool_name":"read_file","tool_info":{"name":"read_file","parameters":{"path":"a.ts"},"output":"..."}}}')).toEqual([
      { kind: 'tool', name: 'read_file', id: 'step-2', input: { path: 'a.ts' } },
    ]);
    expect(parseAntigravityLine('{"event":"step_update","step_update":{"step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"Do"}}')).toEqual([]);
    expect(
      parseAntigravityLine('{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"Done.\\nSTATUS: DONE","duration_seconds":4.2,"num_turns":3,"usage":{"input_tokens":1200,"output_tokens":80,"thinking_tokens":20,"cache_read_tokens":200,"total_tokens":1300}}}'),
    ).toEqual([
      { kind: 'text', text: 'Done.\nSTATUS: DONE' },
      { kind: 'usage', usage: { input: 1000, output: 100, cacheRead: 200, cacheWrite: 0 } },
      { kind: 'final', ok: true, text: 'Done.\nSTATUS: DONE', sessionId: 'c1', numTurns: 3 },
    ]);
    const failed = parseAntigravityLine('{"event":"result","result":{"conversation_id":"c2","status":"ERROR","error":{"type":"AUTH","message":"authentication required"}}}');
    expect(failed[0]).toMatchObject({ kind: 'error', message: 'authentication required', auth: true });
    expect(failed[1]).toMatchObject({ kind: 'final', ok: false, errorMessage: 'authentication required' });
    expect(parseAntigravityLine('{"event":"result","result":{"status":"CANCELED"}}')[1]).toMatchObject({ kind: 'final', ok: false, errorMessage: 'Antigravity stopped with status CANCELED.' });
    expect(parseAntigravityLine('{"event":"result","result":{"status":"ERROR","error":"Resource exhausted: quota"}}')[0]).toMatchObject({ quota: true });
    expect(parseAntigravityLine('nope')).toEqual([]);
  });
});
