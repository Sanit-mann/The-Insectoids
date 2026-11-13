import {
  PROVIDERS_IPC,
  type ProviderPreset,
  ProviderResultSchema,
  ProviderSchema,
  ProviderTestResultSchema,
  ProviderViewSchema,
} from '@insectoids/shared';
import type { LlmRoute } from './llm-route';
import type { ProvidersStore } from './providers';
import type { Vault } from './vault';

export interface ProvidersDeps {
  providers: ProvidersStore;
  vault: Vault;
  llm: LlmRoute;
}

const Id = ProviderSchema.shape.id;
const SetEnabled = ProviderSchema.pick({ id: true, enabled: true });

const message = (err: unknown): string =>
  (err as { name?: string })?.name === 'ZodError' ? 'That input is not valid.' : err instanceof Error ? err.message : String(err);

/**
 * Fallback model ids when a direct-key provider answers the Test but lists none (C4). Only Anthropic: its
 * current models are known (Claude 5 family); OpenAI's own /models list is reliable, so it needs no fallback.
 */
export const KNOWN_MODELS: Partial<Record<ProviderPreset, readonly string[]>> = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
};

/** Model ids from an OpenAI-style `GET /models` answer ({ data: [{ id }] }, or a bare array). */
export function modelIds(body: string): string[] {
  try {
    const j = JSON.parse(body) as unknown;
    const list = Array.isArray(j) ? j : (j as { data?: unknown; models?: unknown })?.data ?? (j as { models?: unknown })?.models;
    if (!Array.isArray(list)) return [];
    const ids = list
      .map((m) => (typeof m === 'string' ? m : typeof (m as { id?: unknown })?.id === 'string' ? (m as { id: string }).id : (m as { name?: unknown })?.name))
      .filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200);
    return [...new Set(ids)].slice(0, 500);
  } catch {
    return [];
  }
}

/**
 * The API providers handlers, as plain functions (a test calls each one and checks that no reply ever
 * carries a key). Inputs are validated; replies are validated against the shared schema.
 */
export function createProvidersHandlers(d: ProvidersDeps): Record<(typeof PROVIDERS_IPC)[keyof typeof PROVIDERS_IPC], (arg: unknown) => Promise<unknown>> {
  const result = (fn: () => void): unknown => {
    try {
      fn();
      return ProviderResultSchema.parse({ ok: true });
    } catch (err) {
      return ProviderResultSchema.parse({ ok: false, error: message(err) });
    }
  };
  const busy = (id: string, what: string): void => {
    if (d.llm.inUse(id)) throw new Error(`A hive run is using this provider right now, so it can't be ${what}. Try again when the goal is done.`);
  };
  return {
    [PROVIDERS_IPC.list]: async () => ProviderViewSchema.array().parse(d.providers.views((ref) => d.vault.has(ref))),
    [PROVIDERS_IPC.save]: async (arg) =>
      result(() => {
        const p = ProviderSchema.parse(arg);
        if (p.secretRef && !d.vault.has(p.secretRef)) throw new Error('That key is not in the Vault.');
        const old = d.providers.get(p.id);
        if (old && (old.baseUrl !== p.baseUrl || old.secretRef !== p.secretRef || (old.enabled && !p.enabled))) busy(p.id, 'changed');
        d.providers.save(p);
      }),
    [PROVIDERS_IPC.setEnabled]: async (arg) =>
      result(() => {
        const { id, enabled } = SetEnabled.parse(arg);
        if (!enabled) busy(id, 'switched off');
        d.providers.setEnabled(id, enabled);
      }),
    [PROVIDERS_IPC.remove]: async (arg) =>
      result(() => {
        const id = Id.parse(arg);
        busy(id, 'removed');
        d.providers.remove(id);
      }),
    [PROVIDERS_IPC.test]: async (arg) => {
      const id = Id.parse(arg);
      const p = d.providers.get(id);
      if (!p) return ProviderTestResultSchema.parse({ ok: false, status: null, message: `No provider "${id}".`, models: [] });
      const r = await d.llm.callAsUser(id, '/models');
      let ok = false;
      let msg: string;
      let models: string[] = [];
      if (!r.ok) msg = r.error;
      else if (r.status >= 200 && r.status < 300) {
        models = modelIds(r.body);
        // A provider that answered but listed nothing: offer its well-known models, if we know them.
        if (!models.length) models = [...(KNOWN_MODELS[p.preset] ?? [])];
        ok = true;
        msg = models.length ? `Connected: ${p.label} lists ${models.length} model${models.length === 1 ? '' : 's'}.` : `Connected to ${p.label}, but it listed no models.`;
      } else if (r.status === 401 || r.status === 403) msg = `${p.label} refused the key (HTTP ${r.status}). Check the key in the Vault.`;
      else msg = `${p.label} answered HTTP ${r.status}.`;
      d.providers.recordTest(id, ok, msg, models);
      return ProviderTestResultSchema.parse({ ok, status: r.ok ? r.status : null, message: msg, models });
    },
  };
}
