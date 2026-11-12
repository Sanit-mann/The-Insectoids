import type { ProviderView } from '@insectoids/shared';

/** What the hive host needs to route work to OpenCode: never a key or a key handle. */
export interface ReadyProviderInfo {
  id: string;
  label: string;
  local: boolean;
  models: ProviderView['models'];
}

/**
 * Providers the hive may use (Phase 2 A4, host request `providers.ready`): switched on, ready, and
 * proven by a successful test (the user saw the model list), in the user's order.
 */
export function readyProviders(views: ProviderView[]): ReadyProviderInfo[] {
  return views
    .filter((v) => v.enabled && v.status === 'ready' && v.lastTestedAt !== null)
    .map((v) => ({ id: v.id, label: v.label, local: v.local, models: v.models }));
}
