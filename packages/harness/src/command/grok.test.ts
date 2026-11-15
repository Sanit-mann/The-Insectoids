import { describe, expect, it } from 'vitest';
import { commandAdapter } from './adapter';
import { buildCommandInvocation } from './args';
import { GROK_PRESET } from './grok';
import { isForbiddenArg, unguardedReason } from './preset';

describe('Grok Build (Phase 4 B4)', () => {
  it('can’t be guarded yet, and says why in plain words', () => {
    const why = unguardedReason(GROK_PRESET);
    expect(why).toMatch(/^Grok Build can't be guarded yet; it will run inside a container once container mode exists\. /);
    expect(why).toMatch(/sign-in/);
    expect(GROK_PRESET.guard).toBeNull();
    expect(GROK_PRESET.tested).toBe(false);
  });

  it('is listed with its real install and sign-in, and never detected or run', () => {
    const a = commandAdapter(GROK_PRESET, { hiveTools: 'hive-tools.mjs', runtime: { command: 'electron.exe' }, runBase: 'C:\\runs' });
    expect(a.detect).toBeUndefined();
    expect(a.capabilities).toMatchObject({ guard: null, mcp: false, subscription: true, reportsCost: false });
    expect(a.unavailableReason).toMatch(/Grok Build can't be guarded yet/);
    expect(a.install?.command).toBe('irm https://x.ai/cli/install.ps1 | iex');
    expect(a.signIn).toMatchObject({ command: 'grok', note: expect.stringMatching(/The hive never sees your login\./) });
    expect(() => buildCommandInvocation(GROK_PRESET, { prompt: 'x', model: null, mcpServers: {}, readOnly: true, runDir: 'C:\\runs\\1' })).toThrow(/can't be guarded yet/);
  });

  it('its headless flags approve nothing; every approve-all flag is forbidden', () => {
    for (const a of GROK_PRESET.headlessArgs) expect(isForbiddenArg(a, GROK_PRESET.forbiddenArgs)).toBe(false);
    expect(GROK_PRESET.headlessArgs).toEqual(expect.arrayContaining(['--no-auto-update']));
    expect(isForbiddenArg('--always-approve', GROK_PRESET.forbiddenArgs)).toBe(true);
    expect(GROK_PRESET.scrubEnv).toContain('GROK_SANDBOX_AUTO_ALLOW_BASH');
  });
});
