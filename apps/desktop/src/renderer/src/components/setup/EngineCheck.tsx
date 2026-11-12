import type { EngineView } from '@insectoids/shared';
import { CircleCheck, CircleDashed, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { CopyCommand } from '@/components/setup/parts';
import { runCommand, useHive } from '@/lib/hive-store';

/** Official Claude Code installers (Anthropic's native installer). We show them; the user runs them. */
const INSTALL: Record<'win32' | 'posix', string> = {
  win32: 'irm https://claude.ai/install.ps1 | iex',
  posix: 'curl -fsSL https://claude.ai/install.sh | bash',
};

const isReady = (e: EngineView | undefined): boolean => e?.state === 'ready' || e?.state === 'fake';

/**
 * Step 3 (08-D5): one working AI engine. Phase 1 checks Claude Code. Install and sign-in always
 * happen in the engine's own tools (04-D2), so we explain the exact command and the user runs it.
 */
export function EngineCheck() {
  const { snapshot, error: hiveError } = useHive();
  const engine = snapshot?.engine;
  const [platform, setPlatform] = useState<'win32' | 'posix'>('posix');
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.insectoids
      .appInfo()
      .then((i) => alive && setPlatform(i.platform === 'win32' ? 'win32' : 'posix'))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const checkAgain = async (): Promise<void> => {
    setChecking(true);
    setCheckError(null);
    const r = await runCommand({ type: 'checkEngine' });
    setChecking(false);
    if (!r.ok) setCheckError(r.error);
  };

  const ready = isReady(engine);
  const state = checking ? 'checking' : (engine?.state ?? 'checking');

  return (
    <div className="flex flex-col gap-4">
      <div
        className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-4"
        data-state={engine?.state ?? 'unknown'}
        data-testid="engine-status"
      >
        {state === 'checking' ? (
          <LoaderCircle aria-hidden="true" className="size-6 shrink-0 text-st-waiting motion-safe:animate-spin" />
        ) : ready ? (
          <CircleCheck aria-hidden="true" className="size-6 shrink-0 text-st-done" />
        ) : (
          <CircleDashed aria-hidden="true" className="size-6 shrink-0 text-st-blocked" />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-semibold text-text">
            {engine?.name ?? 'Claude Code'}
            {engine?.version ? <span className="font-normal text-muted"> · {engine.version}</span> : null}
          </span>
          <span className="text-sm text-muted" role="status">
            {state === 'checking'
              ? 'Checking…'
              : engine?.state === 'fake'
                ? 'Ready (test engine: scripted, uses no tokens).'
                : (engine?.message ?? 'Waiting for the hive to start…')}
          </span>
        </div>
        <span className={ready ? 'text-sm font-semibold text-st-done' : 'text-sm font-semibold text-st-blocked'}>
          {state === 'checking' ? 'Checking' : ready ? 'Ready' : engine?.state === 'signed-out' ? 'Signed out' : engine?.state === 'outdated' ? 'Outdated' : 'Not found'}
        </span>
        <Button disabled={checking} onClick={() => void checkAgain()} variant="outline">
          <RefreshCw aria-hidden="true" className={checking ? 'motion-safe:animate-spin' : undefined} />
          Check again
        </Button>
      </div>

      {engine?.state === 'missing' ? (
        <div className="flex flex-col gap-2">
          <CopyCommand command={INSTALL[platform]} label={platform === 'win32' ? 'Install Claude Code (PowerShell)' : 'Install Claude Code (Terminal)'} />
          <p className="m-0 text-sm text-muted">
            This runs Anthropic&apos;s official installer. We never run it without you: paste it into a terminal yourself, then sign in with{' '}
            <code className="font-mono text-[13px] text-text">claude auth login</code> and press Check again.
          </p>
        </div>
      ) : null}

      {engine?.state === 'signed-out' ? (
        <div className="flex flex-col gap-2">
          <CopyCommand command="claude auth login" label="Sign in to Claude Code" />
          <p className="m-0 text-sm text-muted">
            Run this in a terminal and sign in in your browser, then press Check again. Your login stays with Claude Code; the hive never sees it.
          </p>
        </div>
      ) : null}

      {engine?.state === 'outdated' ? (
        <div className="flex flex-col gap-2">
          <CopyCommand command="claude update" label="Update Claude Code" />
          <p className="m-0 text-sm text-muted">Run this in a terminal, then press Check again.</p>
        </div>
      ) : null}

      {!ready && engine && state !== 'checking' ? (
        <InlineAlert
          message="You can finish setup now and connect an engine later; the hive can't work until one is ready."
          title="You can finish later"
          tone="waiting"
        />
      ) : null}
      {checkError ? <InlineAlert message={checkError} onDismiss={() => setCheckError(null)} title="Could not check the engine" tone="error" /> : null}
      {hiveError && !snapshot ? <InlineAlert message={hiveError} title="The hive is not answering yet" tone="error" /> : null}
    </div>
  );
}
