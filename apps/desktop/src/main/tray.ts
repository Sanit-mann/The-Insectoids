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
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  const tray = new Tray(icon);
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
