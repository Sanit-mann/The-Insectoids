import { Menu, Tray, nativeImage } from 'electron';

interface TrayOptions {
  iconPath: string;
  onOpen: () => void;
  onQuit: () => void;
}

/**
 * System tray (App 07-D7): the hive keeps working when the window is closed.
 * Hive status and Pause arrive with the hive itself in Phase 1.
 */
export function createTray({ iconPath, onOpen, onQuit }: TrayOptions): Tray {
  // No resizing here: the icon files already hold pre-rendered small sizes (see scripts/make-icons.mjs).
  const tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('The Insectoids · hive idle');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open The Insectoids', click: onOpen },
      { type: 'separator' },
      { label: 'Hive: idle', enabled: false },
      { label: 'Pause hive', enabled: false },
      { type: 'separator' },
      { label: 'Quit', click: onQuit },
    ]),
  );
  tray.on('click', onOpen);
  return tray;
}
