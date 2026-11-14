import { Bell, BellOff, Power, PowerOff } from 'lucide-react';
import { useState } from 'react';
import { Switch } from '@/components/connections/Switch';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { type SetupOutcome, setupActions } from '@/lib/setup-store';

/** Shared busy/error handling for a setting switch that calls main. */
function useToggle(action: (next: boolean) => Promise<SetupOutcome>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async (next: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    const r = await action(next);
    setBusy(false);
    if (!r.ok) setError(r.error);
  };
  return { busy, error, clearError: () => setError(null), toggle };
}

/**
 * Desktop notifications (Cadence 05-D8; Phase 3 B2). On by default. Only approvals needed and failures notify, and
 * only while the window isn't in front; everything else waits for the tray and the digest.
 */
export function NotificationsSetting({ enabled }: { enabled: boolean }) {
  const { busy, error, clearError, toggle } = useToggle(setupActions.setNotifications);
  const Icon = enabled ? Bell : BellOff;
  const status = enabled
    ? "On: you get a notification when something needs your approval or fails, while the app isn't in front."
    : 'Off: nothing pops up. The tray and the digest still show what happened.';
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4" data-testid="notifications">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 max-w-[560px] text-sm text-text">
          Only two things notify: something waits for your approval, or something failed. Your computer&apos;s do-not-disturb still
          applies.
        </p>
        <Switch
          checked={enabled}
          disabled={busy}
          label="Desktop notifications for approvals and failures"
          onChange={(v) => void toggle(v)}
        />
      </div>
      <p aria-live="polite" className="m-0 flex items-center gap-2 text-sm text-muted" data-testid="notifications-status">
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        {status}
      </p>
      {error ? <InlineAlert message={error} onDismiss={clearError} title="Could not change notifications" tone="error" /> : null}
    </div>
  );
}

/**
 * Start with my computer (Phase 3 B2). Off by default; started at sign-in, the app stays hidden in the tray. Main
 * says the state in words (`message`); where the app can't register itself (`available` false) the switch is
 * disabled and the message says why.
 */
export function StartWithComputerSetting({ enabled, available, message }: { enabled: boolean; available: boolean; message: string }) {
  const { busy, error, clearError, toggle } = useToggle(setupActions.setStartWithComputer);
  const Icon = enabled ? Power : PowerOff;
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4" data-testid="start-with-computer">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 max-w-[560px] text-sm text-text">
          Start The Insectoids when you sign in, hidden in the tray, so schedules and watches keep running.
        </p>
        <Switch
          checked={enabled}
          disabled={busy || !available}
          label="Start The Insectoids when I sign in"
          onChange={(v) => void toggle(v)}
        />
      </div>
      <p aria-live="polite" className="m-0 flex items-center gap-2 text-sm text-muted" data-testid="start-with-computer-status">
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        {message ||
          (available
            ? enabled
              ? 'On: it starts in the tray when you sign in.'
              : 'Off: start The Insectoids yourself.'
            : "This computer doesn't support starting The Insectoids at sign-in yet.")}
      </p>
      {error ? <InlineAlert message={error} onDismiss={clearError} title="Could not change start with my computer" tone="error" /> : null}
    </div>
  );
}
