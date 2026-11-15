import {
  type ContainerSettings,
  ContainerSettingsSchema,
  type ContainerStatus,
  DEFAULT_CONTAINER_IMAGE,
  DEFAULT_CONTAINER_SETTINGS,
} from '@insectoids/shared';
import { Box, CircleAlert, CircleCheck, CircleOff, Download, ExternalLink, LoaderCircle, type LucideIcon, Power, RefreshCw, Save } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { CONTAINER_MODES } from '@/components/containers/words';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Official download pages (the app never installs a runtime; the user does, from the maker's own page). */
const DOCKER_DESKTOP_URL = 'https://www.docker.com/products/docker-desktop/';
const PODMAN_DESKTOP_URL = 'https://podman-desktop.io/';
/** Progress lines kept on screen while the image downloads (the runtime prints many). */
const PROGRESS_LINES = 6;

const inputCls =
  'min-h-10 w-full rounded-[10px] border border-line bg-ground px-3 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-honey aria-[invalid=true]:border-st-blocked';

type Draft = { image: string; cpus: string; memoryMb: string; pidsLimit: string };
type Note = { tone: 'error' | 'ok'; title: string; message: string };
type Busy = 'mode' | 'save' | 'check' | 'pull' | null;

const draftOf = (s: ContainerSettings): Draft => ({ image: s.image, cpus: String(s.cpus), memoryMb: String(s.memoryMb), pidsLimit: String(s.pidsLimit) });
const sameDraft = (a: Draft, b: Draft): boolean => a.image === b.image && a.cpus === b.cpus && a.memoryMb === b.memoryMb && a.pidsLimit === b.pidsLimit;

/** The form's values checked with the shared schema; each problem is shown under its own field. */
function checkDraft(d: Draft, mode: ContainerSettings['mode']): { settings: ContainerSettings | null; errors: Partial<Record<keyof Draft, string>> } {
  const num = (v: string): number => (v.trim() === '' ? Number.NaN : Number(v));
  const parsed = ContainerSettingsSchema.safeParse({ mode, image: d.image, cpus: num(d.cpus), memoryMb: num(d.memoryMb), pidsLimit: num(d.pidsLimit) });
  if (parsed.success) return { settings: parsed.data, errors: {} };
  const words: Record<Exclude<keyof Draft, 'image'>, string> = {
    cpus: 'CPUs: a number from 0.25 to 64.',
    memoryMb: 'Memory: a whole number of MB, from 256 to 262144.',
    pidsLimit: 'Processes: a whole number from 32 to 4096.',
  };
  const errors: Partial<Record<keyof Draft, string>> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0] as keyof Draft;
    if (key === 'image') errors.image ??= issue.message;
    else if (key in words) errors[key] ??= words[key as Exclude<keyof Draft, 'image'>];
  }
  return { settings: null, errors };
}

/** The runtime state as an icon next to the words (never the icon alone). */
function stateIcon(s: ContainerStatus): { icon: LucideIcon; spin: boolean } {
  if (s.runtime.state === 'checking' || s.pulling) return { icon: LoaderCircle, spin: true };
  if (s.runtime.state === 'missing') return { icon: CircleOff, spin: false };
  if (s.runtime.state === 'not-running') return { icon: Power, spin: false };
  if (s.imagePresent !== true) return { icon: CircleAlert, spin: false };
  return { icon: s.settings.mode === 'off' ? CircleCheck : Box, spin: false };
}

/** "about 80 MB" for the pinned default image; other images' sizes aren't known before the download. */
const sizeWords = (image: string): string => (image === DEFAULT_CONTAINER_IMAGE ? ' (about 80 MB)' : '');

/**
 * Container mode (Phase 4 D1; Workspace & Safety 06-D4). Docker or Podman is detected, never installed; the image is
 * downloaded only when the user presses "Download image" after the screen named it; the user picks Off, When needed
 * or Every card (D2); and a card that needs a container while it isn't ready waits (never on the computer instead).
 * Everything it says comes from the Brain host's status, in a polite live region.
 */
export function ContainersSetting() {
  const [status, setStatus] = useState<ContainerStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [draft, setDraft] = useState<Draft>(draftOf(DEFAULT_CONTAINER_SETTINGS));
  const [touched, setTouched] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  // The mode just chosen, shown checked while it saves (arrow keys move the choice before the host answers).
  const [wantMode, setWantMode] = useState<ContainerSettings['mode'] | null>(null);
  const saved = useRef<Draft | null>(null);
  const ids = useId();

  const apply = useCallback((s: ContainerStatus): void => {
    setStatus(s);
    setLoadError(null);
    // Keep what the user is typing; follow the saved values otherwise.
    const next = draftOf(s.settings);
    setDraft((d) => (saved.current && !sameDraft(d, saved.current) ? d : next));
    saved.current = next;
    setLines((prev) => {
      if (!s.pulling) return prev;
      return prev.at(-1) === s.pulling.line ? prev : [...prev, s.pulling.line].slice(-PROGRESS_LINES);
    });
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      apply(await window.insectoids.containers.status());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [apply]);

  // Read on open, and again whenever the host says container mode changed (checks, download progress, saves).
  useEffect(() => {
    let live = true;
    const read = (): void => {
      window.insectoids.containers
        .status()
        .then((s) => {
          if (live) apply(s);
        })
        .catch((e: unknown) => {
          if (live) setLoadError(e instanceof Error ? e.message : String(e));
        });
    };
    read();
    const off = window.insectoids.hive.onEvent((e) => {
      if (e.type === 'changed' && e.reason === 'containers') read();
    });
    return () => {
      live = false;
      off();
    };
  }, [apply]);

  if (!status) {
    return loadError ? (
      <InlineAlert actions={[{ label: 'Try again', onClick: () => void load(), primary: true }]} message={loadError} title="Couldn't read the container settings" tone="error" />
    ) : (
      <div aria-busy="true" aria-label="Loading container settings" className="h-24 w-full rounded-2xl bg-surface-2 motion-safe:animate-pulse" role="status" />
    );
  }

  const settings = status.settings;
  const { icon: Icon, spin } = stateIcon(status);
  const dirty = !sameDraft(draft, draftOf(settings));
  const checked = checkDraft(draft, settings.mode);
  const showErrors = touched && dirty;
  const runtimeName = status.runtime.kind === 'podman' ? 'Podman' : 'Docker';
  const canDownload = status.runtime.state === 'ready' && status.imagePresent === false && !status.pulling;
  const pulling = status.pulling !== null || busy === 'pull';

  const run = async (kind: Exclude<Busy, null>, fn: () => Promise<{ ok: boolean; error?: string } | void>, failTitle: string): Promise<void> => {
    if (busy) return;
    setBusy(kind);
    setNote(null);
    try {
      const r = await fn();
      if (r && !r.ok) setNote({ tone: 'error', title: failTitle, message: r.error ?? 'Something went wrong.' });
    } catch (err) {
      setNote({ tone: 'error', title: failTitle, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
      await load();
    }
  };

  const mode = wantMode ?? settings.mode;
  const setMode = (next: ContainerSettings['mode']): void => {
    if (busy || next === settings.mode) return;
    setWantMode(next);
    void run('mode', () => window.insectoids.containers.save({ ...settings, mode: next }), "Couldn't change container mode").finally(() => setWantMode(null));
  };
  // A radio group (WAI-ARIA): one tab stop on the chosen mode; arrow keys move to the next one and choose it.
  const modeKey = (ev: KeyboardEvent<HTMLButtonElement>, i: number): void => {
    const step = ev.key === 'ArrowDown' || ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowUp' || ev.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    ev.preventDefault();
    if (busy) return;
    const next = CONTAINER_MODES[(i + step + CONTAINER_MODES.length) % CONTAINER_MODES.length]!.mode;
    document.getElementById(`${ids}-mode-${next}`)?.focus();
    setMode(next);
  };

  const save = (): void => {
    setTouched(true);
    if (!checked.settings) return;
    const next = checked.settings;
    void run(
      'save',
      async () => {
        const r = await window.insectoids.containers.save(next);
        if (r.ok) {
          setTouched(false);
          setNote({ tone: 'ok', title: 'Saved', message: 'The next card runs with these settings.' });
        }
        return r;
      },
      "Couldn't save the container settings",
    );
  };

  const field = (key: keyof Draft, label: string, hint: string, props: { inputMode?: 'decimal' | 'numeric'; mono?: boolean } = {}) => {
    const id = `${ids}-${key}`;
    const error = showErrors ? checked.errors[key] : undefined;
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <label className="text-sm font-medium text-text" htmlFor={id}>
          {label}
        </label>
        <input
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          className={cn(inputCls, props.mono && 'font-mono text-xs')}
          data-testid={`containers-${key}`}
          id={id}
          inputMode={props.inputMode}
          onBlur={() => setTouched(true)}
          onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
          spellCheck={false}
          value={draft[key]}
        />
        <p className="m-0 text-xs text-muted" id={`${id}-hint`}>
          {hint}
        </p>
        {error ? (
          <p className="m-0 text-xs text-st-blocked" data-testid={`containers-${key}-error`} id={`${id}-error`}>
            {error}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4" data-runtime={status.runtime.state} data-testid="containers" data-usable={status.usable}>
      <div className="flex flex-col gap-1 text-sm text-muted">
        <p className="m-0 text-text">
          Container mode runs each card&apos;s commands (tests, builds, installs) inside a throwaway Docker or Podman container that sees only that card&apos;s
          folder, instead of on this computer.
        </p>
        <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5">
          <li>Only commands go into the container. The AI tools themselves still run on this computer, guarded as before; running a whole tool in a container comes later.</li>
          <li>Castes with web access (researchers, analysts, writers) get the open web in the container. All others, including documentation-only castes, get no network at all: a container can&apos;t let only some sites through.</li>
          <li>When a card needs a container but Docker or Podman or the image isn&apos;t ready, it waits. It never runs on this computer instead.</li>
        </ul>
      </div>

      <p aria-live="polite" className="m-0 flex items-start gap-2 text-sm text-text" data-testid="containers-status">
        <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', spin && 'motion-safe:animate-spin')} />
        <span>{status.message}</span>
      </p>

      {status.runtime.state === 'missing' ? (
        <ul aria-label="Where to get a container runtime" className="m-0 flex list-none flex-wrap gap-2 p-0" data-testid="containers-get">
          {[
            { name: 'Docker Desktop', href: DOCKER_DESKTOP_URL },
            { name: 'Podman Desktop', href: PODMAN_DESKTOP_URL },
          ].map((l) => (
            <li key={l.name}>
              {/* Opens in the browser (main allows https links out and never inside the app). */}
              <a
                className="inline-flex min-h-10 items-center gap-2 rounded-[10px] border border-line px-3 text-sm text-text underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-honey"
                href={l.href}
                rel="noreferrer"
                target="_blank"
              >
                <ExternalLink aria-hidden="true" className="size-4" />
                Get {l.name}
                <span className="sr-only"> (opens in your browser)</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          aria-disabled={busy !== null || undefined}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          data-testid="containers-check"
          onClick={() => void run('check', async () => apply(await window.insectoids.containers.recheck()), "Couldn't check for Docker or Podman")}
          size="sm"
          variant="outline"
        >
          <RefreshCw aria-hidden="true" className={cn('size-4', busy === 'check' && 'motion-safe:animate-spin')} />
          {busy === 'check' ? 'Checking…' : 'Check again'}
        </Button>
        {status.runtime.version ? (
          <span className="text-sm text-muted">
            Found {runtimeName} {status.runtime.version}.
          </span>
        ) : null}
      </div>

      {canDownload || pulling ? (
        <div className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface-2/40 p-3" data-testid="containers-download-panel">
          <p className="m-0 text-sm text-text" id={`${ids}-consent`}>
            {pulling ? 'Downloading ' : 'Download '}
            <code className="break-all font-mono text-xs" data-testid="containers-download-image">
              {status.pulling?.image ?? settings.image}
            </code>
            {sizeWords(status.pulling?.image ?? settings.image)} with {runtimeName}? {runtimeName} keeps it on this computer for every card. Nothing else is
            installed, and nothing downloads until you press the button.
          </p>
          <div>
            <Button
              aria-describedby={`${ids}-consent`}
              aria-disabled={pulling || busy !== null || undefined}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              data-testid="containers-download"
              onClick={() => {
                if (pulling || busy) return;
                setLines([]);
                void run('pull', () => window.insectoids.containers.pullImage(), "Couldn't start the download");
              }}
              size="sm"
            >
              {pulling ? <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" /> : <Download aria-hidden="true" className="size-4" />}
              {pulling ? 'Downloading…' : 'Download image'}
            </Button>
          </div>
          {pulling || lines.length ? (
            // A log region of plain lines (a role on a list would take its list semantics away); only the last few
            // lines are kept, so it never needs to scroll.
            <div
              aria-label="Download progress"
              aria-live="polite"
              className="flex flex-col gap-0.5 font-mono text-xs text-muted"
              data-testid="containers-progress"
              role="log"
            >
              {lines.map((l, i) => (
                <p className="m-0 break-all" key={`${i}-${l}`}>
                  {l}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <p className="m-0 text-sm font-medium text-text" id={`${ids}-mode`}>
          When to use a container
        </p>
        {/* Same pattern as the cadence form's trust choice: each option says exactly what it does. */}
        <div aria-busy={busy === 'mode' || undefined} aria-labelledby={`${ids}-mode`} className="flex flex-col gap-2" data-testid="containers-mode" role="radiogroup">
          {CONTAINER_MODES.map((m, i) => {
            const on = mode === m.mode;
            return (
              <button
                aria-checked={on}
                aria-describedby={`${ids}-mode-${m.mode}-sentence`}
                // aria-disabled, not disabled: the chosen option keeps focus while it saves (busy buttons stay focusable).
                aria-disabled={busy !== null || undefined}
                aria-labelledby={`${ids}-mode-${m.mode}-label`}
                className={cn(
                  'flex min-h-10 items-start gap-3 rounded-[10px] border px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-honey aria-disabled:cursor-not-allowed',
                  on ? 'border-honey bg-honey/10' : 'border-line bg-ground hover:bg-surface-2',
                )}
                data-mode={m.mode}
                id={`${ids}-mode-${m.mode}`}
                key={m.mode}
                onClick={() => setMode(m.mode)}
                onKeyDown={(ev) => modeKey(ev, i)}
                role="radio"
                tabIndex={on ? 0 : -1}
                type="button"
              >
                <span aria-hidden="true" className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border', on ? 'border-honey' : 'border-line')}>
                  {on ? <span className="size-2 rounded-full bg-honey" /> : null}
                </span>
                <span className="flex flex-col">
                  <span className="flex items-center gap-2 text-sm font-semibold text-text" id={`${ids}-mode-${m.mode}-label`}>
                    {m.label}
                    {on && busy === 'mode' ? <LoaderCircle aria-hidden="true" className="size-3.5 motion-safe:animate-spin" /> : null}
                  </span>
                  <span className="text-xs text-muted" id={`${ids}-mode-${m.mode}-sentence`}>
                    {m.sentence}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {field('image', 'Image', 'The image every card container starts from, pinned so it never changes under you.', { mono: true })}
        <div className="grid gap-3 sm:grid-cols-3">
          {field('cpus', 'CPUs', 'Most CPU cores one container may use.', { inputMode: 'decimal' })}
          {field('memoryMb', 'Memory (MB)', 'Most memory one container may use.', { inputMode: 'numeric' })}
          {field('pidsLimit', 'Processes', 'Most processes at once, so a runaway command stops.', { inputMode: 'numeric' })}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            aria-disabled={busy !== null || !dirty || undefined}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            data-testid="containers-save"
            onClick={() => {
              if (!busy && dirty) save();
            }}
            size="sm"
          >
            {busy === 'save' ? <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" /> : <Save aria-hidden="true" className="size-4" />}
            {busy === 'save' ? 'Saving…' : 'Save'}
          </Button>
          {draft.image !== DEFAULT_CONTAINER_IMAGE ? (
            <Button data-testid="containers-default-image" onClick={() => setDraft((d) => ({ ...d, image: DEFAULT_CONTAINER_IMAGE }))} size="sm" variant="outline">
              Use the default image
            </Button>
          ) : null}
        </div>
      </div>

      {note ? <InlineAlert message={note.message} onDismiss={() => setNote(null)} title={note.title} tone={note.tone} /> : null}
    </div>
  );
}
