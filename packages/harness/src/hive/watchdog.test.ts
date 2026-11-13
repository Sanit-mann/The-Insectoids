import { describe, expect, it } from 'vitest';
import type { ClaudeEvent } from '../claude/stream';
import { WATCHDOG_DEFAULTS, Watchdog, describeCall } from './watchdog';

const call = (command: string, id = 'x'): ClaudeEvent => ({ kind: 'tool_use', id, name: 'Bash', input: { command } });
const err = (content: string): ClaudeEvent => ({ kind: 'tool_result', toolUseId: 'x', isError: true, content });
const run = (agentId = 'Ant-01', role: 'coder' | 'queen' = 'coder') => ({ runId: `${agentId}#1`, agentId, role, goalId: 'G-1', cardId: role === 'queen' ? null : 'G-1.C-01' });

describe('Watchdog sensors and ladder (C2)', () => {
  it('warns at 5 identical calls and pauses the card at 10', () => {
    const w = new Watchdog().watch(run());
    const trips = Array.from({ length: 12 }, (_, i) => w.event(call('npm test', `t${i}`))).filter(Boolean);
    expect(trips.map((t) => t!.step)).toEqual(['warn', 'pause-card']);
    expect(trips[0]!.sensor).toBe('loop');
    expect(trips[0]!.evidence).toContain('5 times');
    expect(trips[0]!.evidence).toContain('npm test');
    expect(trips[1]!.signature).toBe(trips[0]!.signature);
  });

  it('different arguments are not a loop', () => {
    const w = new Watchdog().watch(run());
    const trips = Array.from({ length: 12 }, (_, i) => w.event(call(`npm test -- file${i}`))).filter(Boolean);
    expect(trips).toEqual([]);
  });

  it('repeated errors trip at 4 and 8; approval answers are ignored', () => {
    const w = new Watchdog().watch(run());
    const trips = Array.from({ length: 9 }, () => w.event(err('Cannot find module "x"'))).filter(Boolean);
    expect(trips.map((t) => [t!.sensor, t!.step])).toEqual([['error-repeat', 'warn'], ['error-repeat', 'pause-card']]);
    const w2 = new Watchdog().watch(run('Ant-02'));
    for (let i = 0; i < 9; i++) expect(w2.event(err("Needs the user's approval [network]"))).toBeNull();
  });

  it('stalls: a window without events warns, a second window pauses the card; events reset it', () => {
    let now = 0;
    const w = new Watchdog({ stallMs: 1000 }, () => now).watch(run());
    now = 900;
    expect(w.idle()).toBeNull();
    now = 1100;
    expect(w.idle()?.step).toBe('warn');
    expect(w.idle()).toBeNull();
    now = 2100;
    expect(w.idle()?.step).toBe('pause-card');
    expect(w.idle()).toBeNull();
  });

  it('a fresh event resets the stall clock', () => {
    let now = 0;
    const w = new Watchdog({ stallMs: 1000 }, () => now).watch(run());
    now = 900;
    w.event({ kind: 'text', text: 'working' });
    now = 1500;
    expect(w.idle()).toBeNull();
  });

  it('for the Queen the second step pauses the hive (02-D12)', () => {
    const w = new Watchdog().watch(run('Queen', 'queen'));
    const trips = Array.from({ length: 10 }, () => w.event(call('ls'))).filter(Boolean);
    expect(trips.map((t) => t!.step)).toEqual(['warn', 'pause-hive']);
  });

  it('does not warn the same agent twice for the same sensor within the cooldown', () => {
    let now = 0;
    const dog = new Watchdog({}, () => now);
    const first = dog.watch(run());
    for (let i = 0; i < 5; i++) first.event(call('a'));
    const second = dog.watch(run());
    const trips = Array.from({ length: 10 }, () => second.event(call('b'))).filter(Boolean);
    // No second warning, but the ladder still reaches "pause the card".
    expect(trips.map((t) => t!.step)).toEqual(['pause-card']);
    now += WATCHDOG_DEFAULTS.warnCooldownMs;
    const third = dog.watch(run());
    expect(Array.from({ length: 5 }, () => third.event(call('c'))).filter(Boolean)[0]?.step).toBe('warn');
  });

  it('a stopped run trips no more', () => {
    const w = new Watchdog().watch(run());
    w.markStopped();
    for (let i = 0; i < 12; i++) expect(w.event(call('npm test'))).toBeNull();
  });

  it('overspend: warn over 3× the share; a hard stop over the run cap', () => {
    const dog = new Watchdog({ hardRunTokens: 100_000 });
    expect(dog.overspend(run(), 20_000, 10_000)).toBeNull();
    expect(dog.overspend(run(), 40_000, 10_000)?.step).toBe('warn');
    expect(dog.overspend(run(), 40_000, null)).toBeNull();
    const hard = dog.overspend(run(), 200_000, null);
    expect(hard?.step).toBe('stop-agent');
    expect(hard?.evidence).toMatch(/hard limit/);
  });

  it('the hive breaker trips at 3 serious trips within the window, then starts over', () => {
    let now = 0;
    const dog = new Watchdog({ hiveTrips: 3, hiveWindowMs: 1000 }, () => now);
    expect(dog.serious()).toBe(false);
    now = 2000; // the first one is now outside the window
    expect(dog.serious()).toBe(false);
    expect(dog.serious()).toBe(false);
    expect(dog.serious()).toBe(true);
    expect(dog.serious()).toBe(false);
  });

  it('describes calls in plain words', () => {
    expect(describeCall('Bash', { command: 'npm   test' })).toBe('Bash: npm test');
    expect(describeCall('Read', { file_path: 'src/a.ts' })).toBe('Read: src/a.ts');
    expect(describeCall('Thing', 3)).toBe('Thing');
  });
});
