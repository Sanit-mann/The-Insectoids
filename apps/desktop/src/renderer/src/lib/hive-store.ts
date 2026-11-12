import { useSyncExternalStore } from 'react';
import type { AgentView, CommandResult, HiveCommand, HiveSnapshot } from '@insectoids/shared';

/**
 * The renderer's one copy of the hive read model.
 * - Reads `hive.snapshot()` at start and again (debounced) on every `changed` push.
 * - Appends `agent-output` pushes to the matching lane without a re-read.
 * - Screens subscribe with `useHive()`; every action goes through `runCommand`.
 */
export interface HiveState {
  snapshot: HiveSnapshot | null;
  /** Set when the last read failed (shown as an inline alert, with retry). */
  error: string | null;
  loading: boolean;
}

const MAX_LINES = 200;
const REFRESH_DEBOUNCE_MS = 150;

let state: HiveState = { snapshot: null, error: null, loading: true };
const listeners = new Set<() => void>();
let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let again = false;

function set(next: Partial<HiveState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function refresh(): Promise<void> {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = (async () => {
    try {
      const snapshot = await window.insectoids.hive.snapshot();
      set({ snapshot, error: null, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    } finally {
      inFlight = null;
      if (again) {
        again = false;
        void refresh();
      }
    }
  })();
  return inFlight;
}

function scheduleRefresh(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void refresh();
  }, REFRESH_DEBOUNCE_MS);
}

function appendOutput(runId: string, lines: string[]): void {
  const snap = state.snapshot;
  if (!snap) return;
  const agents = snap.agents.map((a): AgentView => (a.runId === runId ? { ...a, output: [...a.output, ...lines].slice(-MAX_LINES) } : a));
  set({ snapshot: { ...snap, agents } });
}

function start(): void {
  if (started) return;
  started = true;
  window.insectoids.hive.onEvent((e) => {
    if (e.type === 'agent-output') appendOutput(e.runId, e.lines);
    else scheduleRefresh();
  });
  void refresh();
}

function subscribe(l: () => void): () => void {
  start();
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The whole hive state. Re-renders on every change; select what you need in the component. */
export function useHive(): HiveState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Run one command, then refresh. Never throws: failures come back as { ok: false, error }. */
export async function runCommand(cmd: HiveCommand): Promise<CommandResult> {
  let result: CommandResult;
  try {
    result = await window.insectoids.hive.command(cmd);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  void refresh();
  return result;
}

/** Pending approvals, for the rail badge and the side panel. */
export const pendingApprovals = (s: HiveSnapshot | null) => (s ? s.approvals.filter((a) => a.status === 'waiting') : []);
