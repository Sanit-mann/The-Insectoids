import { useSyncExternalStore } from 'react';
import type { Preset, SaveAbout, SetupResult, SetupState } from '@insectoids/shared';

/**
 * First-run setup state (Onboarding 08), owned by main (`<userData>/app.json`).
 * Loads once, and every action replaces the state with the one main returns.
 * Actions never throw: failures come back as { ok: false, error }.
 */
export interface SetupStoreState {
  state: SetupState | null;
  /** Set when loading failed; the gate shows it with a retry instead of blocking forever. */
  loadError: string | null;
  loading: boolean;
}

let store: SetupStoreState = { state: null, loadError: null, loading: true };
const listeners = new Set<() => void>();
let started = false;

function set(next: Partial<SetupStoreState>): void {
  store = { ...store, ...next };
  for (const l of listeners) l();
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function loadSetup(): Promise<void> {
  set({ loading: true, loadError: null });
  try {
    const api = window.insectoids?.setup;
    if (!api) throw new Error('The setup service is not available in this build.');
    set({ state: await api.state(), loading: false });
  } catch (err) {
    set({ loadError: message(err), loading: false });
  }
}

function subscribe(l: () => void): () => void {
  if (!started) {
    started = true;
    void loadSetup();
  }
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useSetup(): SetupStoreState {
  return useSyncExternalStore(subscribe, () => store);
}

export type SetupOutcome = { ok: true } | { ok: false; error: string };

async function run(call: () => Promise<SetupResult>): Promise<SetupOutcome> {
  try {
    const r = await call();
    set({ state: r.state });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

const api = () => window.insectoids.setup;

export const setupActions = {
  pickBrainFolder: () => run(() => api().pickBrainFolder()),
  useDefaultBrainFolder: () => run(() => api().useDefaultBrainFolder()),
  setPreset: (preset: Preset) => run(() => api().setPreset(preset)),
  saveAbout: (input: SaveAbout) => run(() => api().saveAbout(input)),
  finish: () => run(() => api().finish()),
  restart: () => run(() => api().restart()),
  /**
   * Starts the sample goal on the practice project (08-D8; C5), after the user saw the estimate and said yes.
   * The new state (with `sample`) replaces the old one either way.
   */
  startSample: async (): Promise<{ ok: true; goalId: string; practicePath: string } | { ok: false; error: string }> => {
    try {
      const r = await api().startSample();
      set({ state: r.state });
      return r.ok ? { ok: true, goalId: r.goalId, practicePath: r.practicePath } : { ok: false, error: r.error };
    } catch (err) {
      return { ok: false, error: message(err) };
    }
  },
};

/** Re-read setup state without blanking the screen (checklist items done elsewhere: engines, providers, the sample). */
export async function refreshSetup(): Promise<void> {
  try {
    const api = window.insectoids?.setup;
    if (!api) return;
    set({ state: await api.state(), loadError: null });
  } catch {
    // Keep what we had; the next action brings a fresh state anyway.
  }
}
