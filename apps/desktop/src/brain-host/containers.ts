/**
 * Container mode in the Brain host (Phase 4 D1; Workspace & Safety 06-D4): the user's setting, whether Docker or
 * Podman is on this computer and running, whether the image is here, and the image download. The hive asks
 * `setup()` at the start of every card run that may run commands; the Settings screen reads `status()`.
 *
 * - The runtime is detected, never installed: the words name Docker Desktop and Podman Desktop and where to get them.
 * - The image is downloaded only when the user presses "Download image" (after the screen named it and its size).
 * - Mode on but not usable: card runs are refused with `refusal()`; they never fall back to the computer.
 *
 * No Electron imports, so it is unit-tested under plain Node with a fake runtime.
 */
import {
  type ContainerSettings,
  ContainerSettingsSchema,
  type ContainerStatus,
  DEFAULT_CONTAINER_IMAGE,
  DEFAULT_CONTAINER_SETTINGS,
  type VaultResult,
} from '@insectoids/shared';
import type { HiveContainerSetup } from '@insectoids/harness';
import { type RuntimeFound, detectContainerRuntime, imagePresent, pullImage, removeLeftovers, removeRunContainers } from '@insectoids/workspace';

/** The runtime layer's calls (from @insectoids/workspace), replaceable in tests. */
export interface ContainerRuntimeDeps {
  detect(o: { override?: { command: string; commandArgs: string[] } }): Promise<RuntimeFound | null>;
  imagePresent(rt: RuntimeFound, image: string): Promise<boolean>;
  pullImage(rt: RuntimeFound, image: string, onLine: (line: string) => void): { done: Promise<{ ok: boolean; error?: string }>; stop(): void };
  removeLeftovers(rt: RuntimeFound): Promise<number>;
  /** Removes one run's containers (by its label), when that run ends however it ended. */
  removeRun(rt: { command: string; commandArgs: string[] }, run: string): Promise<number>;
}

export const REAL_CONTAINER_RUNTIME: ContainerRuntimeDeps = {
  detect: (o) => detectContainerRuntime(o),
  imagePresent: (rt, image) => imagePresent(rt, image),
  pullImage: (rt, image, onLine) => pullImage(rt, image, onLine),
  removeLeftovers: (rt) => removeLeftovers(rt),
  removeRun: (rt, run) => removeRunContainers(rt, run),
};

export interface ContainerKeeperOptions {
  settings: ContainerSettings;
  /** Persists the settings with the hive's own (settings.json). */
  save(settings: ContainerSettings): void;
  deps?: ContainerRuntimeDeps;
  /** e2e only: a fake runtime program instead of searching PATH for docker or podman. */
  override?: { command: string; commandArgs: string[] };
  /** Something the status shows changed (the host pushes it to the window). */
  onChange(): void;
  log?: (line: string) => void;
}

type RuntimeState = ContainerStatus['runtime']['state'];

/** Official download pages, named in the words (the app never downloads or installs a runtime itself). */
export const DOCKER_DESKTOP_URL = 'https://www.docker.com/products/docker-desktop/';
export const PODMAN_DESKTOP_URL = 'https://podman-desktop.io/';

const LINE_MAX = 200;
const clip = (s: string): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= LINE_MAX ? one : `${one.slice(0, LINE_MAX - 1)}…`;
};

const product = (kind: RuntimeFound['kind'] | null): { name: string; desktop: string } =>
  kind === 'podman' ? { name: 'Podman', desktop: 'Podman Desktop' } : { name: 'Docker', desktop: 'Docker Desktop' };

/** "the image (about 80 MB)" for the pinned default; other images' sizes aren't known before the download. */
export function imageWords(image: string): string {
  return image === DEFAULT_CONTAINER_IMAGE ? 'the image (about 80 MB)' : 'the image';
}

export class ContainerKeeper {
  readonly #o: ContainerKeeperOptions;
  readonly #deps: ContainerRuntimeDeps;
  #settings: ContainerSettings;
  #state: RuntimeState = 'checking';
  #runtime: RuntimeFound | null = null;
  #image: boolean | null = null;
  #pull: { image: string; line: string; stop(): void } | null = null;
  #pullError: string | null = null;
  #checking: Promise<void> | null = null;
  #leftoversDone = false;
  #disposed = false;

  constructor(o: ContainerKeeperOptions) {
    this.#o = o;
    this.#deps = o.deps ?? REAL_CONTAINER_RUNTIME;
    const parsed = ContainerSettingsSchema.safeParse(o.settings);
    this.#settings = parsed.success ? parsed.data : { ...DEFAULT_CONTAINER_SETTINGS };
  }

  get settings(): ContainerSettings {
    return { ...this.#settings };
  }

  /** Cards can run in containers right now: mode on, runtime running, image here, no download in progress. */
  get usable(): boolean {
    return this.#settings.mode === 'always' && this.#ready;
  }

  get #ready(): boolean {
    return this.#state === 'ready' && this.#runtime !== null && this.#image === true && !this.#pull;
  }

  /**
   * Look for the runtime again (at start and on "Check again"), then for the image. Containers a crash left behind
   * are removed once per app run, the first time a running runtime is found. Never throws: problems become words.
   */
  check(): Promise<void> {
    if (this.#checking) return this.#checking;
    this.#checking = this.#check().finally(() => (this.#checking = null));
    return this.#checking;
  }

  async #check(): Promise<void> {
    this.#state = 'checking';
    this.#o.onChange();
    let rt: RuntimeFound | null = null;
    try {
      rt = await this.#deps.detect(this.#o.override ? { override: this.#o.override } : {});
    } catch (err) {
      this.#o.log?.(`[containers] detection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.#disposed) return;
    this.#runtime = rt;
    this.#image = null;
    // The image is looked for before the state says "ready", so nobody reads a ready runtime with an unknown image.
    if (rt?.running) await this.#checkImage();
    if (this.#disposed) return;
    this.#state = !rt ? 'missing' : rt.running ? 'ready' : 'not-running';
    if (rt?.running) {
      if (!this.#leftoversDone) {
        this.#leftoversDone = true;
        try {
          const n = await this.#deps.removeLeftovers(rt);
          if (n > 0) this.#o.log?.(`[containers] removed ${n} container(s) left behind by an earlier run.`);
        } catch (err) {
          this.#o.log?.(`[containers] could not remove leftovers: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    this.#o.onChange();
  }

  async #checkImage(): Promise<void> {
    const rt = this.#runtime;
    if (!rt?.running) return;
    try {
      this.#image = await this.#deps.imagePresent(rt, this.#settings.image);
    } catch (err) {
      // Unknown counts as missing: the user can download it (a no-op if it was there after all).
      this.#image = false;
      this.#o.log?.(`[containers] could not check the image: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Save the user's settings (validated again here). A new image is looked for at once. */
  async save(next: unknown): Promise<VaultResult> {
    const parsed = ContainerSettingsSchema.safeParse(next);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Those container settings are not valid.' };
    const s = parsed.data;
    if (this.#pull && s.image !== this.#settings.image) return { ok: false, error: 'Wait for the image download to finish before changing the image.' };
    const imageChanged = s.image !== this.#settings.image;
    this.#settings = s;
    this.#o.save(s);
    if (imageChanged) {
      this.#pullError = null;
      this.#image = null;
      await this.#checkImage();
    }
    this.#o.onChange();
    return { ok: true };
  }

  /**
   * Download the configured image: only ever on the user's click (the screen named the image and its size first).
   * Returns once the download started; its progress and outcome come through `status()`.
   */
  pullImage(): VaultResult {
    const rt = this.#runtime;
    if (this.#pull) return { ok: false, error: 'The image is already downloading.' };
    if (this.#state !== 'ready' || !rt?.running) return { ok: false, error: this.#runtimeProblem() ?? 'Docker or Podman is not ready yet.' };
    const image = this.#settings.image;
    this.#pullError = null;
    const pull = { image, line: 'Starting the download…', stop: () => {} };
    this.#pull = pull;
    const handle = this.#deps.pullImage(rt, image, (line) => {
      const l = clip(line);
      if (!l || this.#pull !== pull) return;
      pull.line = l;
      this.#o.onChange();
    });
    pull.stop = handle.stop;
    void handle.done
      .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      .then(async (r) => {
        if (this.#pull !== pull) return;
        this.#pull = null;
        if (this.#disposed) return;
        if (r.ok) {
          await this.#checkImage();
          if (!this.#image) this.#pullError = 'The download finished, but the image still isn’t on this computer.';
        } else {
          this.#pullError = clip(r.error ?? 'The download stopped.');
          this.#o.log?.(`[containers] pull of ${image} failed: ${this.#pullError}`);
        }
        this.#o.onChange();
      });
    this.#o.onChange();
    return { ok: true };
  }

  /**
   * A card run that had a container ended (done, failed, or stopped by a pause, the Watchdog or its time limit):
   * remove its containers, so a stopped run can't leave one working. Best effort; leftovers are also cleared at start.
   */
  runEnded(container: { command: string; commandArgs?: string[]; name: string }): void {
    void this.#deps.removeRun({ command: container.command, commandArgs: container.commandArgs ?? [] }, container.name).catch(() => 0);
  }

  dispose(): void {
    this.#disposed = true;
    this.#pull?.stop();
    this.#pull = null;
  }

  /** What the hive gives each card run (Phase 4 D1). */
  setup(): HiveContainerSetup {
    const s = this.#settings;
    if (s.mode === 'off') return { mode: 'off' };
    const rt = this.#runtime;
    if (!this.#ready || !rt) return { mode: 'always', usable: false, reason: this.refusal() };
    return {
      mode: 'always',
      usable: true,
      runtime: rt.kind,
      command: rt.command,
      commandArgs: [...rt.commandArgs],
      image: s.image,
      cpus: s.cpus,
      memoryMb: s.memoryMb,
      pidsLimit: s.pidsLimit,
    };
  }

  /** Why cards can't run in containers right now, with what to do next (shown on the card and the pause). */
  refusal(): string {
    const problem = this.#runtimeProblem();
    if (problem) return problem;
    if (this.#pull) return `The image ${this.#pull.image} is still downloading; cards start once it's here.`;
    return `The image isn't on this computer yet. Download ${imageWords(this.#settings.image)} on the Containers settings.`;
  }

  /** The runtime's problem in words, or null when it is running. */
  #runtimeProblem(): string | null {
    const p = product(this.#runtime?.kind ?? null);
    switch (this.#state) {
      case 'checking':
        return 'The app is still looking for Docker or Podman.';
      case 'missing':
        return `Neither Docker nor Podman is on this computer. Install Docker Desktop (${DOCKER_DESKTOP_URL}) or Podman Desktop (${PODMAN_DESKTOP_URL}) yourself (the app never installs one), then press Check again on the Containers settings.`;
      case 'not-running':
        return `${p.name} is installed but not running. Start ${p.desktop}, then press Check again on the Containers settings.`;
      default:
        return null;
    }
  }

  status(): ContainerStatus {
    const s = this.#settings;
    const rt = this.#runtime;
    const kind = this.#state === 'missing' || this.#state === 'checking' ? null : (rt?.kind ?? null);
    return {
      settings: { ...s },
      runtime: { state: this.#state, kind, version: kind ? (rt?.version ?? null) : null },
      imagePresent: this.#state === 'ready' ? this.#image : null,
      pulling: this.#pull ? { image: this.#pull.image, line: this.#pull.line } : null,
      usable: this.usable,
      message: this.#message(),
    };
  }

  #message(): string {
    const s = this.#settings;
    const problem = this.#runtimeProblem();
    if (problem) {
      const off = s.mode === 'off' ? ' Container mode is off, so card commands run on this computer, guarded as before.' : ' Until then, cards that run commands wait.';
      return `${problem}${this.#state === 'checking' ? '' : off}`;
    }
    const rt = this.#runtime!;
    const name = `${product(rt.kind).name}${rt.version ? ` ${rt.version}` : ''}`;
    if (this.#pull) return `${name} is ready. Downloading ${this.#pull.image}… Cards that run commands wait until it's here.`;
    if (this.#image !== true) {
      const failed = this.#pullError ? ` The last download didn't finish: ${this.#pullError}` : '';
      return `${name} is ready, but the image isn't on this computer yet. Download ${imageWords(s.image)} on the Containers settings.${failed}`;
    }
    return s.mode === 'always'
      ? `Container mode is on: every card's commands run in a ${product(rt.kind).name} container, with only the card's folder inside.`
      : `${name} is ready and the image is on this computer. Container mode is off: card commands run on this computer, guarded as before.`;
  }
}
