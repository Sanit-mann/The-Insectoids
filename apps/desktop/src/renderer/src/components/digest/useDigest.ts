import type { DigestView } from '@insectoids/shared';
import { useEffect, useState } from 'react';
import { useHive } from '@/lib/hive-store';

export interface DigestState {
  view: DigestView | null;
  error: string | null;
  loading: boolean;
  retry: () => void;
}

/**
 * The full "while you were away" digest (Phase 3 B1), read with `hive.digest()` while `active` (the dialog or the
 * Cadence screen's digest view is open). It reads again when the snapshot's badge changes, so new unattended work
 * shows without reopening. The last good view stays on screen while a new read is under way.
 */
export function useDigest(active: boolean): DigestState {
  const { snapshot } = useHive();
  const badge = snapshot?.digest;
  const [attempt, setAttempt] = useState(0);
  const reqKey = `${badge?.since ?? 0}|${badge?.headline ?? ''}|${badge?.unseen ? 1 : 0}#${attempt}`;
  const [result, setResult] = useState<{ reqKey: string; view: DigestView | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    window.insectoids.hive.digest().then(
      (view) => {
        if (alive) setResult({ reqKey, view, error: null });
      },
      (err: unknown) => {
        if (alive) setResult((prev) => ({ reqKey, view: prev?.view ?? null, error: err instanceof Error ? err.message : String(err) }));
      },
    );
    return () => {
      alive = false;
    };
  }, [active, reqKey]);

  return {
    view: result?.view ?? null,
    error: result?.reqKey === reqKey ? result.error : null,
    loading: active && result?.reqKey !== reqKey,
    retry: () => setAttempt((a) => a + 1),
  };
}
