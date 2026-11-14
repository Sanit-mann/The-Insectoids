/**
 * Working in the background (Cadence 05-D8, App 07-D7; Phase 3 B2): desktop notifications and the tray.
 *
 * Notifications (main process, Electron `Notification`):
 * - **Only two things notify:** something new waits for the user's approval, and a failure (a goal became stuck, a
 *   cadence run failed, a built-in job failed). Everything else stays quiet: goals finishing, runs starting, notes,
 *   skipped or deferred runs, refused webhook calls, routine housekeeping. Those are in the digest.
 * - **Only while the window isn't in front** (hidden in the tray, minimised, or another app focused). The first
 *   snapshot after start is a baseline: nothing that was already waiting notifies.
 * - **Calm:** changes within a few seconds are grouped into one notification ("3 things wait for you"); at most one
 *   notification per kind a minute. Clicking one shows the window on Approvals, or on the stuck goal.
 * - A Settings switch turns them off (on by default). The OS's own do-not-disturb still applies.
 *
 * The tray menu: status in words, "Needs you (N)" opening Approvals, the next scheduled run, "Run now" (a submenu of
 * the open project's cadences and the built-in jobs), Pause/Resume, "Start with my computer" (a checkbox, off by
 * default; not offered on Linux yet), Open, Quit. Started at sign-in, the app stays hidden in the tray.
 *
 * e2e (INSECTOIDS_E2E only): main keeps `globalThis.__insectoidsE2E` (read with `app.evaluate`) so tests can see what
 * the tray shows and what would have notified, and never registers a real login item.
 */
export interface TrayMenuItemModel {
  label: string;
  enabled: boolean;
  /** For checkbox items ("Start with my computer"). */
  checked?: boolean;
  submenu?: TrayMenuItemModel[];
}

export interface TrayModel {
  tooltip: string;
  /** The context menu in order; separators are left out. */
  items: TrayMenuItemModel[];
}

export interface NoticeModel {
  title: string;
  body: string;
  kind: 'approval' | 'failure';
  /** Where a click goes. */
  target: { screen: 'approvals' | 'queen' | 'cadence'; goalId: string | null };
  at: number;
}

export interface BackgroundE2E {
  tray: TrayModel | null;
  /** Every notification main decided to show (newest last), whether or not the OS displayed it. */
  notices: NoticeModel[];
  /** The fake login item (never the real one under e2e). */
  loginItem: { openAtLogin: boolean };
  /** Tests flip this to act as if the window were not in front (Playwright windows often aren't focused anyway). */
  windowInFront: boolean | null;
}
