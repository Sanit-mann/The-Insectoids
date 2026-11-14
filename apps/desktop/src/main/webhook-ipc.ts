import { type IpcMainInvokeEvent, ipcMain } from 'electron';
import {
  WEBHOOK_HOST,
  WEBHOOK_IPC,
  type WebhookInfo,
  WebhookInfoSchema,
  type WebhookSecretResult,
  WebhookSecretResultSchema,
} from '@insectoids/shared';
import { type WebhookCadence, WEBHOOK_ID, type WebhookSecrets, type WebhookService, type WebhookVault } from './webhooks';

export interface WebhookIpcDeps {
  service: WebhookService;
  secrets: WebhookSecrets;
  vault: Pick<WebhookVault, 'status'>;
  /** The open project's webhook cadences, or null when the hive can't say. */
  webhookCadences: () => Promise<WebhookCadence[] | null>;
  /** Electron's clipboard in main: the only place a secret ever goes. */
  clipboard: { writeText(text: string): void };
}

const NOT_HERE = 'No such webhook in this project.';

/**
 * The Cadence screen's webhook handlers (Cadence 05-D4; Phase 3 A4), as plain functions so a test can call them.
 * A secret never travels to the renderer: "Copy secret" puts it on the clipboard here in main.
 */
export function createWebhookHandlers(d: WebhookIpcDeps): Record<(typeof WEBHOOK_IPC)[keyof typeof WEBHOOK_IPC], (arg: unknown) => Promise<unknown>> {
  const find = async (arg: unknown): Promise<WebhookCadence | null> => {
    if (typeof arg !== 'string' || !WEBHOOK_ID.test(arg)) return null;
    return (await d.webhookCadences().catch(() => null))?.find((c) => c.id === arg) ?? null;
  };

  const info = (id: string): WebhookInfo => {
    const base = `http://${WEBHOOK_HOST}:${d.service.port ?? d.service.configuredPort}/hooks/${id}`;
    const hint = d.secrets.hint(id);
    return WebhookInfoSchema.parse({
      cadenceId: id,
      runUrl: base,
      noteUrl: `${base}/note`,
      listening: d.service.listening,
      status: d.service.status,
      hasSecret: d.secrets.reveal(id) !== null,
      secretHint: hint,
      vaultAvailable: d.vault.status().available,
    });
  };

  const withSecret = async (arg: unknown, make: (c: WebhookCadence) => string): Promise<WebhookSecretResult> => {
    const cadence = await find(arg);
    if (!cadence) return WebhookSecretResultSchema.parse({ ok: false, error: NOT_HERE });
    const vault = d.vault.status();
    if (!vault.available) return WebhookSecretResultSchema.parse({ ok: false, error: vault.message });
    try {
      d.clipboard.writeText(make(cadence));
    } catch (err) {
      // Vault errors are plain words and never carry the secret.
      return WebhookSecretResultSchema.parse({ ok: false, error: err instanceof Error ? err.message : 'The secret could not be saved.' });
    }
    return WebhookSecretResultSchema.parse({ ok: true, info: info(cadence.id) });
  };

  return {
    [WEBHOOK_IPC.info]: async (arg) => {
      const cadence = await find(arg);
      if (!cadence) throw new Error(NOT_HERE);
      return info(cadence.id);
    },
    [WEBHOOK_IPC.copySecret]: (arg) => withSecret(arg, (c) => d.secrets.ensure(c.id, c.name)),
    [WEBHOOK_IPC.newSecret]: (arg) => withSecret(arg, (c) => d.secrets.rotate(c.id, c.name)),
  };
}

/** The ipcMain side: trusted sender only, then the validated handler. */
export function registerWebhookIpc(d: WebhookIpcDeps & { assertTrustedSender: (event: IpcMainInvokeEvent) => void }): void {
  for (const [channel, fn] of Object.entries(createWebhookHandlers(d))) {
    ipcMain.handle(channel, async (event, arg: unknown) => {
      d.assertTrustedSender(event);
      return fn(arg);
    });
  }
}
