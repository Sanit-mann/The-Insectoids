import type { App } from 'electron';

/**
 * "Start with my computer" (App 07-D7; Phase 3 B2): off by default. On Windows and macOS the app registers itself
 * as a login item and starts hidden in the tray; Linux desktops differ too much, so it is not offered there yet.
 * Under e2e the real login item is never touched: a fake stands in (`__insectoidsE2E.loginItem`).
 */
export const HIDDEN_ARG = '--hidden';

export const LOGIN_ITEM_MESSAGES = {
  on: 'On: it starts in the tray when you sign in.',
  off: 'Off: start The Insectoids yourself.',
  linux: "Not available on Linux yet: add The Insectoids to your desktop's startup apps.",
} as const;

export interface StartWithComputerState {
  enabled: boolean;
  available: boolean;
  message: string;
}

export interface LoginItemDeps {
  platform: NodeJS.Platform;
  /** Electron's app (real login item). Not used when `fake` is set. */
  app?: Pick<App, 'getLoginItemSettings' | 'setLoginItemSettings'>;
  /** e2e: the fake login item, used instead of the real one. */
  fake?: (() => { openAtLogin: boolean }) | null;
  /** Unpackaged (dev) runs on Windows start Electron itself, so the app's folder goes first in the arguments. */
  devAppPath?: string | null;
}

export class LoginItem {
  readonly #d: LoginItemDeps;

  constructor(d: LoginItemDeps) {
    this.#d = d;
  }

  get available(): boolean {
    return this.#d.platform === 'win32' || this.#d.platform === 'darwin';
  }

  /** Windows matches the login item by path and arguments, so reading and writing use the same ones. */
  #args(): string[] {
    return this.#d.platform === 'win32' && this.#d.devAppPath ? [this.#d.devAppPath, HIDDEN_ARG] : [HIDDEN_ARG];
  }

  #enabled(): boolean {
    if (!this.available) return false;
    if (this.#d.fake) return this.#d.fake().openAtLogin;
    if (!this.#d.app) return false;
    return this.#d.app.getLoginItemSettings(this.#d.platform === 'win32' ? { args: this.#args() } : undefined).openAtLogin;
  }

  state(): StartWithComputerState {
    if (!this.available) return { enabled: false, available: false, message: LOGIN_ITEM_MESSAGES.linux };
    const enabled = this.#enabled();
    return { enabled, available: true, message: enabled ? LOGIN_ITEM_MESSAGES.on : LOGIN_ITEM_MESSAGES.off };
  }

  /** Switch it on or off. Resolves to an error in plain words, or null. */
  set(enabled: boolean): string | null {
    if (!this.available) return LOGIN_ITEM_MESSAGES.linux;
    if (this.#d.fake) {
      this.#d.fake().openAtLogin = enabled;
      return null;
    }
    if (!this.#d.app) return 'The app is still starting.';
    try {
      // Args are Windows-only; on macOS the app sees `wasOpenedAtLogin` instead and stays in the tray.
      this.#d.app.setLoginItemSettings(this.#d.platform === 'win32' ? { openAtLogin: enabled, args: this.#args() } : { openAtLogin: enabled });
    } catch (err) {
      return `Could not change it: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (this.#enabled() !== enabled) {
      return enabled ? 'The computer did not accept it. Check the startup apps in your system settings.' : 'The computer still lists it. Check the startup apps in your system settings.';
    }
    return null;
  }
}

/** Started at sign-in: stay hidden in the tray (Windows passes `--hidden`; macOS says it opened the app at login). */
export function startsHidden(o: { argv: readonly string[]; platform: NodeJS.Platform; wasOpenedAtLogin?: () => boolean }): boolean {
  if (o.argv.includes(HIDDEN_ARG)) return true;
  if (o.platform === 'darwin' && o.wasOpenedAtLogin) {
    try {
      return o.wasOpenedAtLogin();
    } catch {
      return false;
    }
  }
  return false;
}
