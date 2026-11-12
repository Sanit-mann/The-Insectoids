import {
  IntegrationSchema,
  IntegrationViewSchema,
  SecretMetaSchema,
  ServiceTestResultSchema,
  VAULT_IPC,
  VaultAddSchema,
  VaultResultSchema,
  VaultStatusSchema,
} from '@insectoids/shared';
import type { Broker } from './broker';
import type { ProvidersStore } from './providers';
import { type ServicesStore, testRequest } from './services';
import type { Vault } from './vault';

export interface VaultDeps {
  vault: Vault;
  services: ServicesStore;
  broker: Broker;
  /** API providers also use Vault keys (Phase 2 A4). */
  providers?: ProvidersStore;
}

const Id = IntegrationSchema.shape.id;
const Ref = SecretMetaSchema.shape.ref;
const SetEnabled = IntegrationSchema.pick({ id: true, enabled: true });

/** Errors become plain words; a key can never be in them (the Vault and broker never put one there). */
const message = (err: unknown): string =>
  (err as { name?: string })?.name === 'ZodError' ? 'That input is not valid.' : err instanceof Error ? err.message : String(err);

/**
 * The Vault and Services handlers, as plain functions (so a test can call each one and check that no
 * reply ever carries a key). Every input is validated; every reply is validated against the shared schema.
 */
export function createVaultHandlers(d: VaultDeps): Record<(typeof VAULT_IPC)[keyof typeof VAULT_IPC], (arg: unknown) => Promise<unknown>> {
  const result = (fn: () => void): unknown => {
    try {
      fn();
      return VaultResultSchema.parse({ ok: true });
    } catch (err) {
      return VaultResultSchema.parse({ ok: false, error: message(err) });
    }
  };
  return {
    [VAULT_IPC.vaultStatus]: async () => VaultStatusSchema.parse(d.vault.status()),
    [VAULT_IPC.vaultList]: async () =>
      SecretMetaSchema.array().parse(
        d.vault.list().map((s) => ({ ...s, usedBy: [...d.services.usersOf(s.ref), ...(d.providers?.usersOf(s.ref) ?? [])] })),
      ),
    [VAULT_IPC.vaultAdd]: async (arg) => {
      try {
        const input = VaultAddSchema.parse(arg);
        const ref = d.vault.add(input.label, input.value);
        return { ...VaultResultSchema.parse({ ok: true }), ref };
      } catch (err) {
        return VaultResultSchema.parse({ ok: false, error: message(err) });
      }
    },
    [VAULT_IPC.vaultRemove]: async (arg) =>
      result(() => {
        const ref = Ref.parse(arg);
        const users = [
          ...d.services.all().filter((i) => i.enabled && i.secretRef === ref),
          ...(d.providers?.all().filter((p) => p.enabled && p.secretRef === ref) ?? []),
        ];
        if (users.length) {
          throw new Error(`${users.map((u) => u.label).join(', ')} still use${users.length === 1 ? 's' : ''} this key. Switch ${users.length === 1 ? 'it' : 'them'} off first.`);
        }
        d.vault.remove(ref);
      }),
    [VAULT_IPC.servicesList]: async () => IntegrationViewSchema.array().parse(d.services.views((ref) => d.vault.has(ref))),
    [VAULT_IPC.servicesSave]: async (arg) =>
      result(() => {
        const i = IntegrationSchema.parse(arg);
        if (i.secretRef && !d.vault.has(i.secretRef)) throw new Error('That key is not in the Vault.');
        d.services.save(i);
      }),
    [VAULT_IPC.servicesSetEnabled]: async (arg) =>
      result(() => {
        const { id, enabled } = SetEnabled.parse(arg);
        d.services.setEnabled(id, enabled);
      }),
    [VAULT_IPC.servicesRemove]: async (arg) => result(() => d.services.remove(Id.parse(arg))),
    [VAULT_IPC.servicesTest]: async (arg) => {
      const id = Id.parse(arg);
      const i = d.services.get(id);
      if (!i) return ServiceTestResultSchema.parse({ ok: false, status: null, message: `No service "${id}".` });
      const r = await d.broker.callAsUser({ integration: id, ...testRequest(i) });
      const ok = r.ok && r.status >= 200 && r.status < 300;
      const msg = !r.ok
        ? r.error
        : ok
          ? `Connected: ${i.label} answered (HTTP ${r.status}).`
          : r.status === 401 || r.status === 403
            ? `${i.label} refused the key (HTTP ${r.status}). Check the key in the Vault.`
            : `${i.label} answered HTTP ${r.status}.`;
      d.services.recordTest(id, ok, msg);
      return ServiceTestResultSchema.parse({ ok, status: r.ok ? r.status : null, message: msg });
    },
  };
}
