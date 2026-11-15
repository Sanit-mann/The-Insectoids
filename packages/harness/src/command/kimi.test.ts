import { describe, expect, it } from 'vitest';
import { commandAdapter } from './adapter';
import { buildCommandInvocation } from './args';
import { KIMI_PRESET } from './kimi';
import { isForbiddenArg, unguardedReason } from './preset';

describe('the Kimi Code CLI preset (Phase 4 B4)', () => {
  it('can’t be guarded yet, and says why in plain words', () => {
    const why = unguardedReason(KIMI_PRESET);
    expect(why).toMatch(/^Kimi Code CLI can't be guarded yet; it will run inside a container/);
    expect(why).toContain('KIMI_CODE_HOME');
    expect(why).toContain('sign-in');
    expect(KIMI_PRESET.guard).toBeNull();
    expect(KIMI_PRESET.tested).toBe(false);
  });

  it('passes no flag that approves everything, and lists the ones that would', () => {
    for (const a of KIMI_PRESET.headlessArgs) expect(isForbiddenArg(a, KIMI_PRESET.forbiddenArgs)).toBe(false);
    for (const f of ['--yolo', '-y', '--yes', '--auto-approve', '--auto']) expect(isForbiddenArg(f, KIMI_PRESET.forbiddenArgs)).toBe(true);
  });

  it('never builds a command line', () => {
    expect(() => buildCommandInvocation(KIMI_PRESET, { prompt: 'x', model: null, mcpServers: {}, readOnly: true, runDir: 'C:\\runs\\k' })).toThrow(/can't be guarded yet/);
  });

  it('as an engine: listed with its real install and sign-in, never detected or run', () => {
    const a = commandAdapter(KIMI_PRESET, { hiveTools: 'hive-tools.mjs', runtime: { command: 'electron.exe' }, runBase: 'C:\\runs' });
    expect(a.detect).toBeUndefined();
    expect(a.capabilities.guard).toBeNull();
    expect(a.unavailableReason).toMatch(/Kimi Code CLI can't be guarded yet.*would also move its sign-in/);
    expect(a.install?.command).toBe('npm install -g @moonshot-ai/kimi-code@2.4.1');
    expect(a.signIn?.command).toBe('kimi login');
    expect(a).toMatchObject({ id: 'kimi', startsOff: true, capabilities: { subscription: true, mcp: false } });
  });
});
