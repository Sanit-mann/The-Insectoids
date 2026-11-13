import { useCallback, useEffect, useRef, useState } from 'react';

export type Live<T> =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  /** `refreshing`: newer data is on its way; the last data stays on screen meanwhile (no flash). */
  | { state: 'ready'; data: T; refreshing: boolean };

interface Got<T> {
  stamp: string;
  error?: string;
  /** The latest data that loaded, for any stamp. */
  data?: T;
  /** The stamp `data` belongs to. */
  dataStamp?: string;
}

/**
 * Load something from the Brain for a screen (Phase 2 B5), and load it again when the hive says
 * something changed (debounced, since changes come in bursts) or when `key` changes. The last data stays
 * up while a reload runs, so the graph and dashboard don't blink.
 */
export function useLive<T>(key: string, load: () => Promise<T>, debounceMs = 800): { live: Live<T>; reload: () => void } {
  const [tick, setTick] = useState(0);
  const [got, setGot] = useState<Got<T> | null>(null);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = window.insectoids.hive.onEvent((e) => {
      if (e.type !== 'changed') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setTick((t) => t + 1), debounceMs);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, [debounceMs]);

  const stamp = `${key}#${tick}`;
  useEffect(() => {
    let alive = true;
    loadRef
      .current()
      .then((data) => alive && setGot({ stamp, data, dataStamp: stamp }))
      .catch((err: unknown) => alive && setGot((g) => ({ ...g, stamp, error: err instanceof Error ? err.message : String(err) })));
    return () => {
      alive = false;
    };
  }, [stamp]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  let live: Live<T>;
  if (got?.stamp === stamp && got.error !== undefined) live = { state: 'error', message: got.error };
  else if (got?.data !== undefined) live = { state: 'ready', data: got.data, refreshing: got.dataStamp !== stamp };
  else live = { state: 'loading' };
  return { live, reload };
}
