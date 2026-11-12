import { type ReactNode, useState } from 'react';
import { BrandMark } from '@/components/BrandMark';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { SetupWizard } from '@/components/setup/SetupWizard';
import { loadSetup, useSetup } from '@/lib/setup-store';

/**
 * First run: the setup wizard instead of the shell until setup is finished (Onboarding 08).
 * If setup state can't be read, say so with a retry, and offer to open the app anyway:
 * a broken setup service must never lock the user out.
 */
export function SetupGate({ children }: { children: ReactNode }) {
  const { state, loading, loadError } = useSetup();
  const [bypass, setBypass] = useState(false);

  if (bypass) return <>{children}</>;

  if (loadError && !state) {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-[560px] flex-col justify-center gap-4 p-6">
        <BrandMark size={64} />
        <InlineAlert
          actions={[{ label: 'Try again', onClick: () => void loadSetup(), primary: true }]}
          message={loadError}
          title="Could not read the setup state"
          tone="error"
        />
        <button
          className="min-h-10 self-start rounded-[10px] px-3 text-sm text-muted underline-offset-4 hover:underline"
          onClick={() => setBypass(true)}
          type="button"
        >
          Open the app without setup
        </button>
      </div>
    );
  }

  if (loading && !state) {
    return (
      <div
        aria-busy="true"
        aria-label="Loading setup"
        className="mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-center gap-4 p-6"
        role="status"
      >
        <div className="size-16 rounded-2xl bg-surface-2 motion-safe:animate-pulse" />
        <div className="h-7 w-2/3 rounded-lg bg-surface-2 motion-safe:animate-pulse" />
        <div className="h-4 w-full rounded bg-surface-2 motion-safe:animate-pulse" />
        <div className="h-4 w-5/6 rounded bg-surface-2 motion-safe:animate-pulse" />
      </div>
    );
  }

  if (state && !state.completed) return <SetupWizard state={state} />;
  return <>{children}</>;
}
