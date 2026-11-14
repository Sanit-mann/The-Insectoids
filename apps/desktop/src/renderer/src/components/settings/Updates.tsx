import type { UpdateState, UpdateStatus } from '@insectoids/shared';
import {
  CircleAlert,
  CircleArrowDown,
  CircleCheck,
  CircleOff,
  Clock,
  Download,
  ExternalLink,
  Info,
  LoaderCircle,
  type LucideIcon,
  RefreshCw,
  RotateCw,
} from 'lucide-react';
import { useState } from 'react';
import { Switch } from '@/components/connections/Switch';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { type UpdateOutcome, refreshUpdates, updateActions, useUpdates } from '@/lib/update-store';
import { cn } from '@/lib/utils';

/** One icon per status, next to the status in words (status is never the icon alone). */
const STATUS_ICON: Record<UpdateStatus, LucideIcon> = {
  off: CircleOff,
  unsupported: Info,
  idle: Clock,
  checking: LoaderCircle,
  'up-to-date': CircleCheck,
  available: CircleArrowDown,
  downloading: Download,
  ready: RotateCw,
  error: CircleAlert,
};

/** Words for the rare case main sends no message. */
const FALLBACK: Record<UpdateStatus, string> = {
  off: 'Off: the app does not look for new versions.',
  unsupported: 'Update checks run only in the installed app.',
  idle: 'On: it looks for a new version about once a day.',
  checking: 'Looking for a new version…',
  'up-to-date': "You're up to date.",
  available: 'A new version is out.',
  downloading: 'Downloading the new version…',
  ready: 'The new version is ready. Restart when you are.',
  error: "Couldn't check for updates.",
};

interface PrimaryAction {
  label: string;
  icon: LucideIcon;
  /** Absent while main is working (checking, downloading): the button stays, aria-disabled. */
  run?: () => Promise<UpdateOutcome>;
  failTitle: string;
}

const openPage: PrimaryAction = {
  label: 'Open the download page',
  icon: ExternalLink,
  run: updateActions.openRelease,
  failTitle: "Couldn't open the download page",
};

/**
 * The one main button for the current status. It is always the same element, so keyboard focus stays on it while
 * the label moves along (Check now → Checking… → Download → Downloading… → Restart to update).
 */
function primaryAction(s: UpdateState): PrimaryAction | null {
  switch (s.status) {
    case 'idle':
    case 'up-to-date':
    case 'error':
      return { label: 'Check now', icon: RefreshCw, run: updateActions.check, failTitle: "Couldn't check for updates" };
    case 'checking':
      return { label: 'Checking…', icon: LoaderCircle, failTitle: '' };
    case 'available':
      return s.canInstall ? { label: 'Download', icon: Download, run: updateActions.download, failTitle: "Couldn't start the download" } : openPage;
    case 'downloading':
      return { label: 'Downloading…', icon: LoaderCircle, failTitle: '' };
    case 'ready':
      return s.canInstall
        ? { label: 'Restart to update', icon: RotateCw, run: updateActions.restartToUpdate, failTitle: "Couldn't restart to update" }
        : openPage;
    default:
      return null;
  }
}

/**
 * Update checks (Phase 3 C4; Tech stack 09-D4). On by default; it only asks GitHub whether a newer version exists.
 * Never forced: the user downloads, and restarts when they choose. Where the app can't replace itself (macOS, .deb)
 * the button opens the release page instead. The status is always in words, in a polite live region.
 */
export function UpdatesSetting() {
  const { state, error: loadError } = useUpdates();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);

  const act = async (run: () => Promise<UpdateOutcome>, failTitle: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await run();
    setBusy(false);
    if (!r.ok) setError({ title: failTitle, message: r.error });
  };

  if (!state) {
    return loadError ? (
      <InlineAlert
        actions={[{ label: 'Try again', onClick: () => void refreshUpdates(), primary: true }]}
        message={loadError}
        title="Couldn't read the update settings"
        tone="error"
      />
    ) : (
      <div aria-busy="true" aria-label="Loading update settings" className="h-24 w-full rounded-2xl bg-surface-2 motion-safe:animate-pulse" role="status" />
    );
  }

  const Icon = STATUS_ICON[state.status];
  const action = primaryAction(state);
  const working = busy || !action?.run;
  const pct = Math.round((state.progress ?? 0) * 100);

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4" data-status={state.status} data-testid="updates">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex max-w-[560px] flex-col gap-1">
          <p className="m-0 text-sm text-text" data-testid="updates-version">
            This is version {state.currentVersion}.
          </p>
          <p className="m-0 text-sm text-muted">It only asks GitHub whether a newer version exists; nothing about you is sent.</p>
        </div>
        <Switch
          checked={state.enabled}
          disabled={busy}
          label="Check for updates"
          onChange={(v) => void act(() => updateActions.setEnabled(v), "Couldn't change update checks")}
        />
      </div>

      <p aria-live="polite" className="m-0 flex items-center gap-2 text-sm text-muted" data-testid="updates-status">
        <Icon aria-hidden="true" className={cn('size-4 shrink-0', state.status === 'checking' && 'motion-safe:animate-spin')} />
        {state.message || FALLBACK[state.status]}
      </p>

      {state.status === 'downloading' ? (
        <div className="flex items-center gap-3">
          <div
            aria-label="Download progress"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={pct}
            className="h-2 w-full max-w-[420px] overflow-hidden rounded-full bg-surface-2"
            data-testid="updates-progress"
            role="progressbar"
          >
            <div className="h-full rounded-full bg-honey transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${pct}%` }} />
          </div>
          <span aria-hidden="true" className="text-sm tabular-nums text-muted">
            {pct}%
          </span>
        </div>
      ) : null}

      {action ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            aria-disabled={working || undefined}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            data-testid="updates-action"
            onClick={() => {
              if (action.run) void act(action.run, action.failTitle);
            }}
            size="sm"
            variant={state.status === 'ready' || state.status === 'available' ? 'default' : 'outline'}
          >
            <action.icon aria-hidden="true" className={cn('size-4', !action.run && 'motion-safe:animate-spin')} />
            {action.label}
          </Button>
          {state.status === 'ready' && state.canInstall ? (
            <span className="text-sm text-muted" data-testid="updates-restart-note">
              Your Brain and settings stay as they are.
            </span>
          ) : null}
        </div>
      ) : null}

      {state.notes ? (
        <details className="rounded-[10px] border border-line bg-surface-2/40 px-3" data-testid="updates-notes">
          <summary className="cursor-pointer rounded-md py-2.5 text-sm font-semibold text-text outline-none focus-visible:ring-2 focus-visible:ring-honey">
            What&apos;s new{state.latestVersion ? ` in version ${state.latestVersion}` : ''}
          </summary>
          <p className="m-0 max-h-72 overflow-y-auto pb-3 text-sm whitespace-pre-wrap break-words text-text">{state.notes}</p>
        </details>
      ) : null}

      {error ? <InlineAlert message={error.message} onDismiss={() => setError(null)} title={error.title} tone="error" /> : null}
    </div>
  );
}
