/**
 * Messages between the main process and the Brain host over the utility process's parentPort.
 * The master token travels only here: never in argv or the environment, where child processes
 * and process listings could see it.
 */
export interface DoorPaths {
  /** Runtime for door processes: the app's own executable run as Node. */
  runtime: { command: string; env: Record<string, string> };
  guardHook: string;
  brainMcp: string;
  brainCli: string;
}

export type ToHost =
  | { type: 'start'; dbPath: string; endpoint: string; masterToken: string; doors: DoorPaths }
  | { type: 'stop' };

export type FromHost = { type: 'ready'; endpoint: string } | { type: 'failed'; message: string } | { type: 'stopped' };

export function isStartMessage(m: unknown): m is Extract<ToHost, { type: 'start' }> {
  if (typeof m !== 'object' || m === null) return false;
  const o = m as Record<string, unknown>;
  return o['type'] === 'start' && typeof o['dbPath'] === 'string' && typeof o['endpoint'] === 'string' && typeof o['masterToken'] === 'string' && typeof o['doors'] === 'object' && o['doors'] !== null;
}
