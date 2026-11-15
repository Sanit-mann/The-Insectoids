import { describe, expect, it } from 'vitest';
import { commandAdapter } from './adapter';
import { buildCommandInvocation } from './args';
import { CRUSH_PRESET } from './crush';
import { isForbiddenArg, unguardedReason } from './preset';

describe('Crush (Phase 4 B4)', () => {
  it('can’t be guarded yet, and says why in plain words', () => {
    const why = unguardedReason(CRUSH_PRESET);
    expect(why).toMatch(/^Crush can't be guarded yet; it will run inside a container once container mode exists\. /);
    expect(why).toMatch(/approves every tool call/);
    expect(CRUSH_PRESET.guard).toBeNull();
    expect(CRUSH_PRESET.tested).toBe(false);
  });

  it('is listed with its real install and sign-in, and never detected or run', () => {
    const a = commandAdapter(CRUSH_PRESET, { hiveTools: 'hive-tools.mjs', runtime: { command: 'electron.exe' }, runBase: 'C:\\runs' });
    expect(a.detect).toBeUndefined();
    expect(a.capabilities).toMatchObject({ guard: null, mcp: false, subscription: false, reportsCost: false, effort: ['low', 'medium', 'high'] });
    expect(a.unavailableReason).toMatch(/Crush can't be guarded yet/);
    expect(a.install?.command).toBe('npm install -g @charmland/crush@0.99.0');
    expect(a.signIn).toMatchObject({ command: 'crush login', note: expect.stringMatching(/The hive never sees your login\./) });
    expect(() => buildCommandInvocation(CRUSH_PRESET, { prompt: 'x', model: null, mcpServers: {}, readOnly: true, runDir: 'C:\\runs\\1' })).toThrow(/can't be guarded yet/);
  });

  it('its headless flags approve nothing; every --yolo form is forbidden', () => {
    for (const a of CRUSH_PRESET.headlessArgs) expect(isForbiddenArg(a, CRUSH_PRESET.forbiddenArgs)).toBe(false);
    expect(CRUSH_PRESET.headlessArgs).toEqual(['run', '--quiet']);
    for (const f of ['--yolo', '--yolo=2', '-y', '-yy', '--host']) expect(isForbiddenArg(f, CRUSH_PRESET.forbiddenArgs)).toBe(true);
  });

  it('reads its version line', () => {
    expect(CRUSH_PRESET.version.pattern.exec('crush version v0.99.0')?.[1]).toBe('0.99.0');
  });
});
