import { type IpcMainInvokeEvent, ipcMain } from 'electron';
import { CONTAINER_IPC, ContainerSettingsSchema, ContainerStatusSchema, VaultResultSchema } from '@insectoids/shared';
import type { BrainHost } from './brain-host';

interface Deps {
  host: () => BrainHost | null;
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
}

/**
 * Container mode over IPC (Phase 4 D1). The setting, the runtime checks and the image download live in the Brain
 * host (the hive asks it on every card run); main only checks the sender, validates what goes in and what comes
 * back. Changes reach the window as the hive push `{ type: 'changed', reason: 'containers' }`.
 */
export function registerContainerIpc(d: Deps): void {
  const host = (): BrainHost => {
    const h = d.host();
    if (!h) throw new Error('The Brain is not running.');
    return h;
  };
  const handle = (channel: string, fn: (arg: unknown) => Promise<unknown>): void => {
    ipcMain.handle(channel, async (event, arg: unknown) => {
      d.assertTrustedSender(event);
      return fn(arg);
    });
  };

  handle(CONTAINER_IPC.status, async () => ContainerStatusSchema.parse(await host().call('containersStatus')));
  handle(CONTAINER_IPC.recheck, async () => ContainerStatusSchema.parse(await host().call('containersRecheck')));
  handle(CONTAINER_IPC.save, async (arg) => {
    // A bad value comes back in words (the form shows it), never as a thrown schema dump.
    const parsed = ContainerSettingsSchema.safeParse(arg);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Those container settings are not valid.' };
    return VaultResultSchema.parse(await host().call('containersSave', parsed.data));
  });
  // Takes nothing from the window: the host downloads the image the settings name, and only on this click.
  handle(CONTAINER_IPC.pullImage, async () => VaultResultSchema.parse(await host().call('containersPull')));
}
