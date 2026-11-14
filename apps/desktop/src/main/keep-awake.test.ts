import { describe, expect, it } from 'vitest';
import { KeepAwake, type SleepBlocker } from './keep-awake';

function fakeBlocker(): SleepBlocker & { started: Set<number>; starts: number } {
  let next = 1;
  const started = new Set<number>();
  const b = {
    started,
    starts: 0,
    start: () => {
      b.starts++;
      const id = next++;
      started.add(id);
      return id;
    },
    stop: (id: number) => void started.delete(id),
    isStarted: (id: number) => started.has(id),
  };
  return b;
}

describe('keep the computer awake while the hive works (05-D5)', () => {
  it('only while the switch is on and the hive is working', () => {
    const b = fakeBlocker();
    const k = new KeepAwake(b);
    expect(k.update({ enabled: false, working: true })).toBe(false);
    expect(k.update({ enabled: true, working: false })).toBe(false);
    expect(b.started.size).toBe(0);
    expect(k.update({ enabled: true, working: true })).toBe(true);
    expect(b.started.size).toBe(1);
  });

  it('starts once while it stays needed, and lets the computer sleep as soon as the hive is idle', () => {
    const b = fakeBlocker();
    const k = new KeepAwake(b);
    k.update({ enabled: true, working: true });
    k.update({ enabled: true, working: true });
    expect(b.starts).toBe(1);
    expect(k.update({ enabled: true, working: false })).toBe(false);
    expect(b.started.size).toBe(0);
  });

  it('switching it off stops it at once, and release() never leaves one behind', () => {
    const b = fakeBlocker();
    const k = new KeepAwake(b);
    k.update({ enabled: true, working: true });
    expect(k.update({ enabled: false, working: true })).toBe(false);
    k.update({ enabled: true, working: true });
    k.release();
    expect(b.started.size).toBe(0);
    expect(k.active).toBe(false);
  });

  it('starts again if the system dropped its blocker', () => {
    const b = fakeBlocker();
    const k = new KeepAwake(b);
    k.update({ enabled: true, working: true });
    b.started.clear();
    expect(k.update({ enabled: true, working: true })).toBe(true);
    expect(b.starts).toBe(2);
  });
});
