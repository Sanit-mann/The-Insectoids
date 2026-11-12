import { useSyncExternalStore } from 'react';
import type { ProviderView } from '@insectoids/shared';

/**
 * The renderer's copy of the API providers list (Connections 04-D3; Phase 2 · A4).
 * Like the Vault store, it only holds metadata: a provider's key stays in the Vault and is referenced
 * by its handle. Read on first use and after every action; screens subscribe with `useProviders()`.
 */
export interface ProvidersState {
  providers: ProviderView[];
  loading: boolean;
  /** Set when the last read failed (shown inline, with retry). */
  error: string | null;
}

let state: ProvidersState = { providers: [], loading: true, error: null };
const listeners = new Set<() => void>();
let started = false;
let inFlight: Promise<void> | null = null;

function set(next: Partial<ProvidersState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function refreshProviders(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const api = window.insectoids.providers;
      if (!api) throw new Error('API providers are not available in this version of the app.');
      set({ providers: await api.list(), loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: message(err) });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function subscribe(l: () => void): () => void {
  if (!started) {
    started = true;
    void refreshProviders();
  }
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useProviders(): ProvidersState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Runs one providers action, then re-reads. Never throws: failures come back as an error string. */
export async function providerAction<T extends { ok: boolean; error?: string }>(run: () => Promise<T>): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  try {
    const result = await run();
    void refreshProviders();
    if (!result.ok) return { ok: false, error: result.error ?? 'That did not work.' };
    return { ok: true, result };
  } catch (err) {
    void refreshProviders();
    return { ok: false, error: message(err) };
  }
}
