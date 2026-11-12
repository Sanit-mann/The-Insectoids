import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeHookLauncher } from './hook-launcher';

// A folder with a space and a percent sign, like "The Insectoids" under AppData.
const tmp = mkdtempSync(join(tmpdir(), 'insectoids hook 100% '));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('guard hook launcher', () => {
  it('runs the hook with its env set, passes stdin and the exit code through, and leaks nothing', () => {
    const script = join(tmp, 'fake hook.mjs');
    writeFileSync(
      script,
      `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(JSON.stringify({flag:process.env.HOOK_FLAG,input:s.trim()}));process.exit(2);});`,
    );
    const launch = writeHookLauncher(join(tmp, 'hooks'), { command: process.execPath, env: { HOOK_FLAG: 'on' } }, script);
    const r = spawnSync(launch.command, launch.args, { input: '{"tool":"Bash"}', encoding: 'utf8', env: { ...process.env, HOOK_FLAG: undefined } });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout)).toEqual({ flag: 'on', input: '{"tool":"Bash"}' });
    // The caller's own environment was never touched.
    expect(process.env['HOOK_FLAG']).toBeUndefined();
  });

  it('refuses quotes and newlines that could break out of the launcher', () => {
    expect(() => writeHookLauncher(tmp, { command: 'a"b', env: {} }, 'x.mjs')).toThrow(/quote/);
    expect(() => writeHookLauncher(tmp, { command: 'node', env: { 'BAD NAME': '1' } }, 'x.mjs')).toThrow(/Invalid/);
  });
});
