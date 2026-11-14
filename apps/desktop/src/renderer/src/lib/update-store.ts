import { useSyncExternalStore } from 'react';
import type { UpdateApi, UpdateState } from '@insectoids/shared';

/**
 * The renderer's one copy of the update state (Phase 3 C4), shared by Settings → Updates and the top-bar notice.
 * - Reads `updates.state()` at start and follows `updates.onChanged` pushes.
 * - Every action resolves to the fresh state, which replaces ours; failures come back as { ok: false, error }.
 */
export interface UpdatesView {
  state: UpdateState | null;
  /** Set when reading the state failed (shown as an inline alert, with retry). */
  error: string | null;
}

let view: UpdatesView = { state: null, error: null };
const listeners = new Set<() => void>();
let started = false;

function set(next: Partial<UpdatesView>): void {
  view = { ...view, ...next };
  for (const l of listeners) l();
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Read the state again (also the "Try again" after a failed read). */
export async function refreshUpdates(): Promise<void> {
  try {
    set({ state: await window.insectoids.updates.state(), error: null });
  } catch (err) {
    set({ error: message(err) });
  }
}

function start(): void {
  if (started) return;
  started = true;
  try {
    window.insectoids.updates.onChanged((s) => set({ state: s, error: null }));
  } catch (err) {
    set({ error: message(err) });
    return;
  }
  void refreshUpdates();
}

function subscribe(l: () => void): () => void {
  start();
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useUpdates(): UpdatesView {
  return useSyncExternalStore(subscribe, () => view);
}

export type UpdateOutcome = { ok: true } | { ok: false; error: string };

async function run(call: (api: UpdateApi) => Promise<UpdateState>): Promise<UpdateOutcome> {
  try {
    set({ state: await call(window.insectoids.updates), error: null });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

export const updateActions = {
  setEnabled: (enabled: boolean) => run((u) => u.setEnabled(enabled)),
  check: () => run((u) => u.check()),
  download: () => run((u) => u.download()),
  restartToUpdate: () => run((u) => u.restartToUpdate()),
  openRelease: () => run((u) => u.openRelease()),
};

/** id of the Settings → Updates heading (the target of the top-bar notice). */
export const UPDATES_HEADING_ID = 'settings-updates';

/** Open Settings and bring the Updates section into view, with focus on its heading. */
export function openUpdatesSettings(): void {
  window.dispatchEvent(new CustomEvent('insectoids:navigate', { detail: 'settings' }));
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let tries = 0;
  const find = (): void => {
    const el = document.getElementById(UPDATES_HEADING_ID);
    if (el) {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      el.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
      el.focus({ preventScroll: true });
      return;
    }
    // Settings may still be loading its setup state: keep looking for a couple of seconds.
    if (++tries < 120) requestAnimationFrame(find);
  };
  requestAnimationFrame(find);
}
