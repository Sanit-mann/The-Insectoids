import { Menu, type MenuItemConstructorOptions, Tray, nativeImage } from 'electron';
import type { CadenceView, TrayMenuItemModel, TrayModel } from '@insectoids/shared';

/** What the tray shows (App 07-D7): working / idle / needs you, plus the approvals count. */
export interface TrayState {
  working: number;
  approvals: number;
  paused: boolean;
}

/** Tooltip text; exported for tests. Status is always words, never only an icon colour. */
export function trayLabel(s: TrayState): string {
  const parts: string[] = [];
  if (s.paused) parts.push('hive paused');
  else if (s.working > 0) parts.push(`hive working (${s.working} ${s.working === 1 ? 'agent' : 'agents'})`);
  else parts.push('hive idle');
  if (s.approvals > 0) parts.push(`needs you (${s.approvals} ${s.approvals === 1 ? 'approval' : 'approvals'})`);
  return `The Insectoids · ${parts.join(' · ')}`;
}

/** The cadence fields the tray reads (a full `CadenceView` fits). */
export type TrayCadence = Pick<CadenceView, 'id' | 'name' | 'enabled' | 'builtIn' | 'nextRunAt'>;

/** Everything the tray menu is built from (B2). */
export interface TrayInput {
  status: TrayState;
  /** The open project's cadences and the built-in jobs, in snapshot order (empty while the Brain isn't ready). */
  cadences: readonly TrayCadence[];
  /** A "while you were away" digest waits to be read. */
  digestUnseen: boolean;
  /** "Start with my computer": hidden where it isn't available (Linux for now). */
  startWithComputer: { available: boolean; enabled: boolean };
  now: number;
}

/** What a tray item does when clicked. */
export type TrayAction =
  | { type: 'open' }
  | { type: 'approvals' }
  | { type: 'digest' }
  | { type: 'runNow'; cadenceId: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'startWithComputer'; enabled: boolean }
  | { type: 'quit' };

export interface TrayItem extends TrayMenuItemModel {
  action?: TrayAction;
  submenu?: TrayItem[];
}

export const PAUSED_RUN_REASON = 'The hive is paused: resume it to run these';
export const NOTHING_TO_RUN = 'Nothing to run yet';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const pad = (n: number): string => String(n).padStart(2, '0');
const startOfDay = (t: number): number => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** A time in simple local words: "today 09:00", "tomorrow 09:00", "Mon 09:00" (this week), else "3 Dec 09:00". */
export function whenWords(at: number, now: number): string {
  if (at <= now) return 'now';
  const d = new Date(at);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  // Whole calendar days between the two dates (rounded, so a daylight-saving shift doesn't matter).
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  if (days === 0) return `today ${hm}`;
  if (days === 1) return `tomorrow ${hm}`;
  if (days < 7) return `${WEEKDAYS[d.getDay()]} ${hm}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${hm}`;
}

/** The soonest enabled scheduled run: the user's own cadences first, else the built-in jobs. */
export function nextRun(cadences: readonly TrayCadence[]): TrayCadence | null {
  const soonest = (list: TrayCadence[]): TrayCadence | null =>
    list.filter((c) => c.enabled && c.nextRunAt !== null).sort((a, b) => a.nextRunAt! - b.nextRunAt!)[0] ?? null;
  return soonest(cadences.filter((c) => !c.builtIn)) ?? soonest(cadences.filter((c) => c.builtIn));
}

/** The tray menu as data (pure, tested); `createTray` turns it into the Electron menu. Separators are left out. */
export function buildTrayModel(i: TrayInput): { tooltip: string; items: TrayItem[] } {
  const label = trayLabel(i.status);
  const items: TrayItem[] = [{ label: label.replace('The Insectoids · ', '').replace(/^./, (c) => c.toUpperCase()), enabled: false }];
  if (i.status.approvals > 0) items.push({ label: `Needs you (${i.status.approvals})`, enabled: true, action: { type: 'approvals' } });

  const next = nextRun(i.cadences);
  items.push({ label: next ? `Next: ${next.name} ${whenWords(next.nextRunAt!, i.now)}` : 'Nothing scheduled', enabled: false });

  const runnable = [...i.cadences.filter((c) => c.enabled && !c.builtIn), ...i.cadences.filter((c) => c.enabled && c.builtIn)];
  const runItems: TrayItem[] = runnable.map((c) => ({ label: c.name, enabled: !i.status.paused, action: { type: 'runNow', cadenceId: c.id } }));
  const submenu: TrayItem[] = !runItems.length ? [{ label: NOTHING_TO_RUN, enabled: false }] : i.status.paused ? [{ label: PAUSED_RUN_REASON, enabled: false }, ...runItems] : runItems;
  items.push({ label: 'Run now', enabled: true, submenu });

  if (i.digestUnseen) items.push({ label: 'While you were away', enabled: true, action: { type: 'digest' } });
  items.push(i.status.paused ? { label: 'Resume hive', enabled: true, action: { type: 'resume' } } : { label: 'Pause hive', enabled: true, action: { type: 'pause' } });
  if (i.startWithComputer.available) {
    const on = i.startWithComputer.enabled;
    items.push({ label: 'Start with my computer', enabled: true, checked: on, action: { type: 'startWithComputer', enabled: !on } });
  }
  items.push({ label: 'Open The Insectoids', enabled: true, action: { type: 'open' } });
  items.push({ label: 'Quit', enabled: true, action: { type: 'quit' } });
  return { tooltip: label, items };
}

/** The model without click actions (what e2e reads from `__insectoidsE2E.tray`). */
export function plainTrayModel(m: { tooltip: string; items: TrayItem[] }): TrayModel {
  const plain = (it: TrayItem): TrayMenuItemModel => ({
    label: it.label,
    enabled: it.enabled,
    ...(it.checked !== undefined ? { checked: it.checked } : {}),
    ...(it.submenu ? { submenu: it.submenu.map(plain) } : {}),
  });
  return { tooltip: m.tooltip, items: m.items.map(plain) };
}

/** Where separators go: before these labels. */
const SEPARATE_BEFORE = new Set(['Run now', 'Open The Insectoids']);

function template(items: TrayItem[], act: (a: TrayAction) => void, top: boolean): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = [];
  for (const it of items) {
    if (top && SEPARATE_BEFORE.has(it.label) && out.length) out.push({ type: 'separator' });
    const action = it.action;
    out.push({
      label: it.label,
      enabled: it.enabled,
      ...(it.checked !== undefined ? { type: 'checkbox' as const, checked: it.checked } : {}),
      ...(it.submenu ? { submenu: template(it.submenu, act, false) } : {}),
      ...(action ? { click: () => act(action) } : {}),
    });
  }
  return out;
}

/**
 * System tray (App 07-D7): the hive keeps working when the window is closed. `update` rebuilds the menu from the
 * hive's real state; clicks go to `onAction`. Returns the latest model (e2e keeps it).
 */
export function createTray(o: { iconPath: string; onAction: (a: TrayAction) => void }): { tray: Tray; update(i: TrayInput): TrayModel } {
  // No resizing here: the icon files already hold pre-rendered small sizes (see scripts/make-icons.mjs).
  const tray = new Tray(nativeImage.createFromPath(o.iconPath));
  const update = (i: TrayInput): TrayModel => {
    const model = buildTrayModel(i);
    tray.setToolTip(model.tooltip);
    tray.setContextMenu(Menu.buildFromTemplate(template(model.items, o.onAction, true)));
    return plainTrayModel(model);
  };
  tray.on('click', () => o.onAction({ type: 'open' }));
  return { tray, update };
}
