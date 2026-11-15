import { z } from 'zod';
import type { VaultResult } from './vault-api';

/**
 * Container mode settings and status (Phase 4 D1; Workspace & Safety 06-D4).
 *
 * - The runtime (Docker, else Podman) is **detected, never installed**: the app shows where to get one.
 * - The image is **pulled only when the user says so** (a download): the button names the image first.
 * - D1 has one switch: off (default) or every card's shell commands in a container. Who chooses per card
 *   (the Queen, the Watchdog, the user per goal) comes in D2.
 * - When container mode is on but the runtime or image isn't ready, cards that would run shell commands
 *   don't fall back to the computer: their runs are refused in plain words until it's ready or switched off.
 *
 * e2e (INSECTOIDS_E2E only): `INSECTOIDS_E2E_CONTAINER_RUNTIME` names a fake runtime program used instead of
 * searching PATH for docker/podman (see packages/workspace/src/fake-runtime.mjs).
 */
export const CONTAINER_IPC = {
  status: 'containers:status',
  save: 'containers:save',
  recheck: 'containers:recheck',
  pullImage: 'containers:pull-image',
} as const;

/** The default image: Node 22 on Debian slim, pinned by tag and digest (pushed 2026-10-21, about 80 MB). */
export const DEFAULT_CONTAINER_IMAGE =
  'node:22.23.3-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9';

/** An image reference the app will pass to the runtime: name[:tag][@sha256:digest], nothing a shell would read. */
export const ContainerImageSchema = z
  .string()
  .trim()
  .max(300)
  .regex(/^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]{1,128})?(@sha256:[a-f0-9]{64})?$/, 'That isn’t an image name the app can use (like node:22-bookworm-slim).');

export const ContainerSettingsSchema = z.object({
  /** off: commands run on the computer (guarded as before). always: every card's commands run in a container. */
  mode: z.enum(['off', 'always']),
  image: ContainerImageSchema,
  cpus: z.number().min(0.25).max(64),
  memoryMb: z.number().int().min(256).max(262_144),
  pidsLimit: z.number().int().min(32).max(4096),
});
export type ContainerSettings = z.infer<typeof ContainerSettingsSchema>;

export const DEFAULT_CONTAINER_SETTINGS: ContainerSettings = {
  mode: 'off',
  image: DEFAULT_CONTAINER_IMAGE,
  cpus: 2,
  memoryMb: 2048,
  pidsLimit: 256,
};

export const ContainerStatusSchema = z.object({
  settings: ContainerSettingsSchema,
  runtime: z.object({
    /** missing: neither Docker nor Podman found; not-running: found, but its service isn't answering. */
    state: z.enum(['checking', 'missing', 'not-running', 'ready']),
    kind: z.enum(['docker', 'podman']).nullable(),
    version: z.string().nullable(),
  }),
  /** Is the image on this computer? null while unknown (no runtime yet). */
  imagePresent: z.boolean().nullable(),
  /** A pull in progress, with the runtime's last line of progress. */
  pulling: z.object({ image: z.string(), line: z.string() }).nullable(),
  /** Can cards run in containers right now (mode on, runtime ready, image present)? */
  usable: z.boolean(),
  /** Plain words, including what to do next. */
  message: z.string(),
});
export type ContainerStatus = z.infer<typeof ContainerStatusSchema>;

/** The containers part of `window.insectoids`. */
export interface ContainerApi {
  status(): Promise<ContainerStatus>;
  save(settings: ContainerSettings): Promise<VaultResult>;
  /** Looks for the runtime again (after the user installed or started it). */
  recheck(): Promise<ContainerStatus>;
  /** Downloads the configured image: only ever on the user's click, after the UI named the image. */
  pullImage(): Promise<VaultResult>;
}
