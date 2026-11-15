import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type HookPolicy, fsRealpath, preToolUse, runHook, toClaudeCodeOutput } from './hook';

const policy: HookPolicy = {
  platform: 'posix',
  workspace: '/hive/G-1/C-01',
  home: '/home/sam',
  linkedPaths: [],
  noGo: [],
  network: 'docs',
};

const call = (tool_name: string, tool_input: Record<string, unknown>, p: HookPolicy = policy) =>
  preToolUse({ hook_event_name: 'PreToolUse', tool_name, tool_input }, p).decision;

describe('mapping Claude Code tools to guard checks', () => {
  it('checks shell commands', () => {
    expect(call('Bash', { command: 'npm test' })).toBe('allow');
    expect(call('Bash', { command: 'rm -rf /' })).toBe('block');
    expect(call('Bash', { command: 'git push' })).toBe('ask');
  });

  it('checks file reads and writes', () => {
    expect(call('Read', { file_path: '/hive/G-1/C-01/src/app.ts' })).toBe('allow');
    expect(call('Read', { file_path: '/hive/G-1/C-01/.env' })).toBe('block');
    expect(call('Write', { file_path: '/home/sam/x.txt', content: 'x' })).toBe('block');
    expect(call('Edit', { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' })).toBe('allow');
    expect(call('NotebookEdit', { notebook_path: '/etc/x.ipynb', new_source: '' })).toBe('block');
    expect(call('Grep', { pattern: 'key', path: '/home/sam/.ssh' })).toBe('block');
  });

  it('applies the caste network policy (Workspace 06-D7)', () => {
    expect(call('WebFetch', { url: 'https://developer.mozilla.org/en-US/docs/Web', prompt: 'x' })).toBe('allow');
    expect(call('WebFetch', { url: 'https://registry.npmjs.org/zod', prompt: 'x' })).toBe('allow');
    expect(call('WebFetch', { url: 'https://random-blog.example.com/post', prompt: 'x' })).toBe('block');
    expect(call('WebFetch', { url: 'https://random-blog.example.com/post', prompt: 'x' }, { ...policy, network: 'web' })).toBe('allow');
    expect(call('WebSearch', { query: 'zod v4 docs' }, { ...policy, network: 'none' })).toBe('block');
    expect(call('WebFetch', { url: 'http://developer.mozilla.org/', prompt: 'x' }, { ...policy, network: 'web' })).toBe('block');
  });

  it('an approval lets through exactly that kind of action, never a blocked one', () => {
    const approved = { ...policy, approvedRules: ['new-dependency'] };
    expect(call('Bash', { command: 'npm install zod' }, approved)).toBe('allow');
    expect(call('Bash', { command: 'git push' }, approved)).toBe('ask');
    expect(call('Bash', { command: 'rm -rf /' }, { ...policy, approvedRules: ['delete-outside'] })).toBe('block');
  });

  it('lets coordination tools and MCP tools through; asks about anything unknown', () => {
    expect(call('TodoWrite', { todos: [] })).toBe('allow');
    expect(call('mcp__brain__search', { query: 'x' })).toBe('allow');
    expect(call('SomeNewTool', {})).toBe('ask');
  });
});

describe('Claude Code hook output', () => {
  it('allows with an explicit allow', () => {
    const out = toClaudeCodeOutput({ decision: 'allow' });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'allow' });
  });

  it('denies a block with its reason', () => {
    const out = toClaudeCodeOutput({ decision: 'block', rule: 'force-push', reason: 'Force-pushing is never allowed.' });
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('deny');
    expect(hso.permissionDecisionReason).toContain('Force-pushing');
  });

  it('turns "ask" into a deny that tells the insect to block its card and wait for approval', () => {
    const out = toClaudeCodeOutput({ decision: 'ask', rule: 'push', reason: 'Pushing needs your approval.' });
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('deny');
    expect(hso.permissionDecisionReason).toMatch(/approval/i);
    expect(hso.permissionDecisionReason).toMatch(/blocked/i);
  });
});

describe('a real link on disk cannot be used to write outside the workspace', () => {
  it('resolves links with fsRealpath before deciding', () => {
    const root = mkdtempSync(join(tmpdir(), 'insectoids-guard-'));
    try {
      const workspace = join(root, 'card');
      const outside = join(root, 'users-documents');
      mkdirSync(join(workspace, 'src'), { recursive: true });
      mkdirSync(outside);
      symlinkSync(outside, join(workspace, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
      const env = { INSECTOIDS_GUARD: JSON.stringify({ workspace, home: root, network: 'none' }) };
      const write = (file_path: string) =>
        JSON.parse(runHook(JSON.stringify({ tool_name: 'Write', tool_input: { file_path, content: 'x' } }), env, fsRealpath).stdout)
          .hookSpecificOutput.permissionDecision;
      expect(write(join(workspace, 'docs', 'plan.md'))).toBe('deny');
      expect(write(join(workspace, 'src', 'plan.md'))).toBe('allow');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runHook fails closed', () => {
  const env = { INSECTOIDS_GUARD: JSON.stringify(policy) };

  it('runs end to end from stdin and the policy in the environment', () => {
    const out = runHook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /home/sam' } }), env);
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('denies when the input is not valid JSON', () => {
    expect(JSON.parse(runHook('not json', env).stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('denies when the guard policy is missing', () => {
    const out = runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), {});
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('container mode (Phase 4 D1)', () => {
  const contained: HookPolicy = {
    ...policy,
    container: {
      runtime: 'docker', command: '/usr/bin/docker', image: 'node:22-bookworm-slim', network: 'none',
      cpus: 2, memoryMb: 2048, pidsLimit: 256, name: 'insectoids-g-1-c-01-ab12',
    },
  };

  it("blocks Claude Code's own shell tools and points at the hive's run_shell", () => {
    for (const tool of ['Bash', 'PowerShell', 'BashOutput', 'KillShell']) {
      const v = preToolUse({ tool_name: tool, tool_input: { command: 'npm test' } }, contained);
      expect(v, tool).toEqual({ decision: 'block', rule: 'container-mode', reason: "This card runs in container mode: run commands with the hive's run_shell tool." });
    }
    // Even an approval for a rule can't bring the host shell back.
    expect(call('Bash', { command: 'npm install zod' }, { ...contained, approvedRules: ['new-dependency', 'container-mode'] })).toBe('block');
    const out = JSON.parse(runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), { INSECTOIDS_GUARD: JSON.stringify(contained) }).stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/container mode: run commands with the hive's run_shell tool/);
  });

  it('leaves everything else as it was', () => {
    expect(call('mcp__insectoids-hive-tools__run_shell', { command: 'npm test' }, contained)).toBe('allow');
    expect(call('Read', { file_path: '/hive/G-1/C-01/src/app.ts' }, contained)).toBe('allow');
    expect(call('Read', { file_path: '/hive/G-1/C-01/.env' }, contained)).toBe('block');
    expect(call('Edit', { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' }, contained)).toBe('allow');
    expect(call('TodoWrite', { todos: [] }, contained)).toBe('allow');
    expect(call('WebFetch', { url: 'https://developer.mozilla.org/', prompt: 'x' }, contained)).toBe('allow');
    // Without container mode, Bash is checked by the command guard as before.
    expect(call('Bash', { command: 'npm test' })).toBe('allow');
    expect(call('BashOutput', { bash_id: 'x' })).toBe('allow');
  });
});
