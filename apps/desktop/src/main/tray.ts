import { Menu, Tray, nativeImage } from 'electron';

interface TrayOptions {
  iconPath: string;
  onOpen: () => void;
  onQuit: () => void;
  onPause: () => void;
  onResume: () => void;
}

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

/**
 * System tray (App 07-D7): the hive keeps working when the window is closed.
 * `update` reflects the hive's real state; Pause / Resume act on it.
 */
export function createTray(o: TrayOptions): { tray: Tray; update(s: TrayState): void } {
  // No resizing here: the icon files already hold pre-rendered small sizes (see scripts/make-icons.mjs).
  const tray = new Tray(nativeImage.createFromPath(o.iconPath));
  const update = (s: TrayState): void => {
    tray.setToolTip(trayLabel(s));
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open The Insectoids', click: o.onOpen },
        { type: 'separator' },
        { label: trayLabel(s).replace('The Insectoids · ', '').replace(/^./, (c) => c.toUpperCase()), enabled: false },
        s.paused ? { label: 'Resume hive', click: o.onResume } : { label: 'Pause hive', click: o.onPause },
        { type: 'separator' },
        { label: 'Quit', click: o.onQuit },
      ]),
    );
  };
  update({ working: 0, approvals: 0, paused: false });
  tray.on('click', o.onOpen);
  return { tray, update };
}
