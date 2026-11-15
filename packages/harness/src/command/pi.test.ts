import { describe, expect, it } from 'vitest';
import { commandAdapter } from './adapter';
import { buildCommandInvocation } from './args';
import { PI_PRESET, parsePiLine } from './pi';
import { isForbiddenArg, unguardedReason } from './preset';

describe('the Pi preset (Phase 4 B4)', () => {
  it('can’t be guarded yet, and says why in plain words', () => {
    const why = unguardedReason(PI_PRESET);
    expect(why).toMatch(/^Pi can't be guarded yet; it will run inside a container/);
    expect(why).toContain('no permission system');
    expect(why).toContain('auth.json');
    expect(PI_PRESET.guard).toBeNull();
    expect(PI_PRESET.tested).toBe(false);
  });

  it('passes no flag that loosens it, and lists the ones that would', () => {
    for (const a of PI_PRESET.headlessArgs) expect(isForbiddenArg(a, PI_PRESET.forbiddenArgs)).toBe(false);
    expect(PI_PRESET.headlessArgs).toEqual(expect.arrayContaining(['--mode', 'json', '--no-session', '--no-extensions', '--no-approve']));
    // --api-key would put a secret on the command line; --approve trusts project config.
    for (const f of ['--approve', '-a', '--api-key=sk-x', '--extension', '-e']) expect(isForbiddenArg(f, PI_PRESET.forbiddenArgs)).toBe(true);
  });

  it('never builds a command line', () => {
    expect(() => buildCommandInvocation(PI_PRESET, { prompt: 'x', model: null, mcpServers: {}, readOnly: true, runDir: 'C:\\runs\\p' })).toThrow(/can't be guarded yet/);
  });

  it('reads Pi’s documented --mode json events', () => {
    expect(parsePiLine('{"type":"session","version":3,"id":"0b1","timestamp":"2026-11-15T10:00:00Z","cwd":"C:\\\\work"}')).toEqual([]);
    expect(parsePiLine('{"type":"message_start","message":{"role":"user","content":"Fix it","timestamp":1}}')).toEqual([]);
    expect(parsePiLine('{"type":"tool_execution_start","toolCallId":"tc1","toolName":"read","args":{"path":"a.ts"}}')).toEqual([
      { kind: 'tool', name: 'read', id: 'tc1', input: { path: 'a.ts' } },
    ]);
    const end = parsePiLine(
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Done.' }, { type: 'toolCall', id: 'x', name: 'read', arguments: {} }],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          usage: { input: 120, output: 30, cacheRead: 1000, cacheWrite: 0, totalTokens: 1150, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } },
          stopReason: 'stop',
          timestamp: 2,
        },
      }),
    );
    expect(end).toEqual([
      { kind: 'text', text: 'Done.' },
      { kind: 'usage', usage: { input: 120, output: 30, cacheRead: 1000, cacheWrite: 0 }, model: 'claude-sonnet-4-5', costUsd: 0.3 },
      { kind: 'final', ok: true, text: 'Done.', model: 'claude-sonnet-4-5' },
    ]);
    const failed = parsePiLine('{"type":"message_end","message":{"role":"assistant","content":[],"model":"m","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"total":0}},"stopReason":"error","errorMessage":"429 rate limit exceeded"}}');
    expect(failed).toContainEqual({ kind: 'error', message: '429 rate limit exceeded', quota: true });
    expect(failed.at(-1)).toMatchObject({ kind: 'final', ok: false });
    expect(parsePiLine('{"type":"auto_retry_end","success":false,"attempt":3,"finalError":"401 Unauthorized"}')).toEqual([{ kind: 'error', message: '401 Unauthorized', auth: true }]);
    expect(parsePiLine('{"type":"auto_retry_end","success":true,"attempt":2}')).toEqual([]);
    expect(parsePiLine('{"type":"agent_settled","aborted":false}')).toEqual([]);
    expect(parsePiLine('{"type":"agent_settled","aborted":true}')).toEqual([{ kind: 'final', ok: false, errorMessage: 'Pi stopped the run.' }]);
    expect(parsePiLine('{"type":"message_update","usage":{"input":5},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Do"}}')).toEqual([]);
    expect(parsePiLine('nope')).toEqual([]);
  });

  it('as an engine: listed with its real install, never detected or run', () => {
    const a = commandAdapter(PI_PRESET, { hiveTools: 'hive-tools.mjs', runtime: { command: 'electron.exe' }, runBase: 'C:\\runs' });
    expect(a.detect).toBeUndefined();
    expect(a.capabilities.guard).toBeNull();
    expect(a.unavailableReason).toMatch(/Pi can't be guarded yet.*never copies/);
    expect(a.install?.command).toBe('npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.4.0');
    expect(a).toMatchObject({ id: 'pi', startsOff: true, capabilities: { subscription: false, effort: ['low', 'medium', 'high'] } });
  });
});
