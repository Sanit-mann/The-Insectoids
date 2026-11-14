import { describe, expect, it } from 'vitest';
import { NOTHING_TO_RUN, PAUSED_RUN_REASON, type TrayCadence, type TrayInput, buildTrayModel, nextRun, plainTrayModel, whenWords } from './tray';

// Saturday 14 November 2026, 10:00 local time.
const NOW = new Date(2026, 10, 14, 10, 0).getTime();
const at = (day: number, h: number, m = 0): number => new Date(2026, 10, day, h, m).getTime();

const cad = (id: string, p: Partial<TrayCadence> = {}): TrayCadence => ({ id, name: `Cadence ${id}`, enabled: true, builtIn: false, nextRunAt: null, ...p });

function input(p: Partial<TrayInput> = {}): TrayInput {
  return {
    status: { working: 0, approvals: 0, paused: false },
    cadences: [],
    digestUnseen: false,
    startWithComputer: { available: true, enabled: false },
    now: NOW,
    ...p,
  };
}

const labels = (i: TrayInput): string[] => buildTrayModel(i).items.map((x) => x.label);
const item = (i: TrayInput, label: string) => buildTrayModel(i).items.find((x) => x.label === label);

describe('tray menu (App 07-D7; B2)', () => {
  it('a calm hive: status, nothing scheduled, run now, pause, start with my computer, open, quit', () => {
    expect(labels(input())).toEqual(['Hive idle', 'Nothing scheduled', 'Run now', 'Pause hive', 'Start with my computer', 'Open The Insectoids', 'Quit']);
    expect(buildTrayModel(input()).tooltip).toBe('The Insectoids · hive idle');
    expect(item(input(), 'Hive idle')!.enabled).toBe(false);
  });

  it('"Needs you (N)" only when something waits, opening Approvals', () => {
    const i = input({ status: { working: 1, approvals: 2, paused: false } });
    expect(labels(i).slice(0, 2)).toEqual(['Hive working (1 agent) · needs you (2 approvals)', 'Needs you (2)']);
    expect(item(i, 'Needs you (2)')!.action).toEqual({ type: 'approvals' });
  });

  it('the next run: the soonest enabled user cadence first, else a built-in job', () => {
    const user = cad('a', { name: 'Morning review', nextRunAt: at(15, 9) });
    const later = cad('b', { name: 'Later', nextRunAt: at(20, 9) });
    const off = cad('c', { name: 'Off', enabled: false, nextRunAt: at(14, 11) });
    const job = cad('maint-backup', { name: 'Back up the Brain', builtIn: true, nextRunAt: at(14, 12) });
    expect(labels(input({ cadences: [later, user, off, job] }))).toContain('Next: Morning review tomorrow 09:00');
    expect(labels(input({ cadences: [off, job] }))).toContain('Next: Back up the Brain today 12:00');
    expect(nextRun([cad('w', { nextRunAt: null })])).toBeNull();
  });

  it('time in simple local words', () => {
    expect(whenWords(at(14, 18, 30), NOW)).toBe('today 18:30');
    expect(whenWords(at(15, 9), NOW)).toBe('tomorrow 09:00');
    expect(whenWords(at(16, 9), NOW)).toBe('Mon 09:00');
    expect(whenWords(at(25, 9), NOW)).toBe('25 Nov 09:00');
    expect(whenWords(NOW - 1, NOW)).toBe('now');
  });

  it('"Run now" lists enabled cadences, then the built-in jobs', () => {
    const i = input({ cadences: [cad('maint-backup', { name: 'Back up the Brain', builtIn: true }), cad('a', { name: 'Morning review' }), cad('x', { name: 'Off', enabled: false })] });
    const sub = item(i, 'Run now')!.submenu!;
    expect(sub.map((s) => [s.label, s.enabled])).toEqual([
      ['Morning review', true],
      ['Back up the Brain', true],
    ]);
    expect(sub[0]!.action).toEqual({ type: 'runNow', cadenceId: 'a' });
    expect(item(input(), 'Run now')!.submenu!.map((s) => s.label)).toEqual([NOTHING_TO_RUN]);
  });

  it('paused: "Run now" says why and its items are disabled; Resume replaces Pause', () => {
    const i = input({ status: { working: 0, approvals: 0, paused: true }, cadences: [cad('a', { name: 'Morning review' })] });
    const sub = item(i, 'Run now')!.submenu!;
    expect(sub.map((s) => [s.label, s.enabled])).toEqual([
      [PAUSED_RUN_REASON, false],
      ['Morning review', false],
    ]);
    expect(labels(i)).toContain('Resume hive');
    expect(labels(i)).not.toContain('Pause hive');
  });

  it('"While you were away" only when a digest waits', () => {
    expect(labels(input())).not.toContain('While you were away');
    expect(item(input({ digestUnseen: true }), 'While you were away')!.action).toEqual({ type: 'digest' });
  });

  it('"Start with my computer" is a checkbox showing the real state, and hidden on Linux', () => {
    const on = item(input({ startWithComputer: { available: true, enabled: true } }), 'Start with my computer')!;
    expect(on.checked).toBe(true);
    expect(on.action).toEqual({ type: 'startWithComputer', enabled: false });
    expect(item(input(), 'Start with my computer')!.checked).toBe(false);
    expect(labels(input({ startWithComputer: { available: false, enabled: false } }))).not.toContain('Start with my computer');
  });

  it('the e2e model carries no click actions', () => {
    const m = plainTrayModel(buildTrayModel(input({ status: { working: 0, approvals: 1, paused: false } })));
    expect(JSON.stringify(m)).not.toContain('action');
    expect(m.items[1]).toEqual({ label: 'Needs you (1)', enabled: true });
  });
});
