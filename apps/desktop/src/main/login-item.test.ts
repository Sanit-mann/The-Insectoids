import { describe, expect, it, vi } from 'vitest';
import { HIDDEN_ARG, LOGIN_ITEM_MESSAGES, LoginItem, startsHidden } from './login-item';

function fakeApp(open = false) {
  let openAtLogin = open;
  return {
    getLoginItemSettings: vi.fn(() => ({ openAtLogin }) as ReturnType<Electron.App['getLoginItemSettings']>),
    setLoginItemSettings: vi.fn((s: Electron.Settings) => {
      openAtLogin = s.openAtLogin === true;
    }),
  };
}

describe('start with my computer (B2)', () => {
  it('is not available on Linux, in words, and never touches anything', () => {
    const app = fakeApp();
    const li = new LoginItem({ platform: 'linux', app });
    expect(li.state()).toEqual({ enabled: false, available: false, message: LOGIN_ITEM_MESSAGES.linux });
    expect(li.set(true)).toBe(LOGIN_ITEM_MESSAGES.linux);
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('under e2e uses the fake, never the real login item', () => {
    const app = fakeApp();
    const fake = { openAtLogin: false };
    const li = new LoginItem({ platform: 'win32', app, fake: () => fake });
    expect(li.set(true)).toBeNull();
    expect(fake.openAtLogin).toBe(true);
    expect(li.state()).toEqual({ enabled: true, available: true, message: LOGIN_ITEM_MESSAGES.on });
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(app.getLoginItemSettings).not.toHaveBeenCalled();
  });

  it('on Windows registers with --hidden and reads the state back with the same arguments', () => {
    const app = fakeApp();
    const li = new LoginItem({ platform: 'win32', app });
    expect(li.state().message).toBe(LOGIN_ITEM_MESSAGES.off);
    expect(li.set(true)).toBeNull();
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, args: [HIDDEN_ARG] });
    expect(app.getLoginItemSettings).toHaveBeenLastCalledWith({ args: [HIDDEN_ARG] });
    expect(li.state().enabled).toBe(true);
  });

  it('on macOS registers without arguments', () => {
    const app = fakeApp();
    expect(new LoginItem({ platform: 'darwin', app }).set(true)).toBeNull();
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
  });

  it('says so when the computer did not take it', () => {
    const app = { ...fakeApp(), setLoginItemSettings: vi.fn() };
    expect(new LoginItem({ platform: 'win32', app }).set(true)).toMatch(/did not accept/);
  });

  it('started at sign-in stays hidden', () => {
    expect(startsHidden({ argv: ['app.exe', HIDDEN_ARG], platform: 'win32' })).toBe(true);
    expect(startsHidden({ argv: ['app.exe'], platform: 'win32' })).toBe(false);
    expect(startsHidden({ argv: ['app'], platform: 'darwin', wasOpenedAtLogin: () => true })).toBe(true);
    expect(startsHidden({ argv: ['app'], platform: 'linux', wasOpenedAtLogin: () => true })).toBe(false);
  });
});
