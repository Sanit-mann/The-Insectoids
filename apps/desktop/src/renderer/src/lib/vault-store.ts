import { useSyncExternalStore } from 'react';
import type { IntegrationView, SecretMeta, VaultStatus } from '@insectoids/shared';

/**
 * The renderer's copy of the Vault and Services metadata (Connections 04-D4; Phase 2 · A3).
 * It only ever holds what the contract allows: key labels, hints and handles, never a key.
 * Read on first use and after every action; screens subscribe with `useVault()`.
 */
export interface VaultState {
  status: VaultStatus | null;
  secrets: SecretMeta[];
  services: IntegrationView[];
  loading: boolean;
  /** Set when the last read failed (shown inline, with retry). */
  error: string | null;
}

let state: VaultState = { status: null, secrets: [], services: [], loading: true, error: null };
const listeners = new Set<() => void>();
let started = false;
let inFlight: Promise<void> | null = null;

function set(next: Partial<VaultState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function refreshVault(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const api = window.insectoids.vault;
      if (!api) throw new Error('The Vault is not available in this version of the app.');
      const [status, secrets, services] = await Promise.all([api.status(), api.list(), api.services()]);
      set({ status, secrets, services, loading: false, error: null });
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
    void refreshVault();
  }
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useVault(): VaultState {
  return useSyncExternalStore(subscribe, () => state);
}

/**
 * Runs one Vault or Services action, then re-reads. Never throws: failures come back as an error string.
 * Error text comes from the main process, which never puts a key in a message.
 */
export async function vaultAction<T extends { ok: boolean; error?: string }>(run: () => Promise<T>): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  try {
    const result = await run();
    void refreshVault();
    if (!result.ok) return { ok: false, error: result.error ?? 'That did not work.' };
    return { ok: true, result };
  } catch (err) {
    void refreshVault();
    return { ok: false, error: message(err) };
  }
}
