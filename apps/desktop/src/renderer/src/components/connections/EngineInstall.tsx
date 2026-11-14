import type { EngineCard, EngineInstallResult } from '@insectoids/shared';
import { Check, Copy, Download, LoaderCircle, TerminalSquare } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { refresh } from '@/lib/hive-store';
import { copyText } from './CopyCommand';

/** Only one install runs at a time, across every engine card. */
let running: string | null = null;
const listeners = new Set<() => void>();
const setRunning = (id: string | null): void => {
  running = id;
  for (const l of listeners) l();
};
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const useRunning = (): string | null => useSyncExternalStore(subscribe, () => running);

/** Keep the live output readable: the last lines only. */
const MAX_LINES = 400;

type Phase = { state: 'ask' } | { state: 'running' } | { state: 'done'; result: EngineInstallResult } | { state: 'error'; message: string };

/**
 * One-click install with consent (Connections 04-D6; Phase 2 C4). The button opens a dialog that shows the
 * exact command first and asks before anything runs. The main process runs only the engine's own official
 * command (never text from here), streams its output, and checks the engine again at the end.
 */
export function EngineInstall({ engine: e, offer }: { engine: EngineCard; /** Show the button (missing or outdated). The dialog stays mounted either way. */ offer: boolean }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ state: 'ask' });
  const [lines, setLines] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const busyId = useRunning();
  const outputRef = useRef<HTMLPreElement | null>(null);
  const install = e.install;
  const verb = e.state === 'outdated' ? 'Update' : 'Install';

  // Live output for this engine only, while it runs.
  useEffect(() => {
    if (phase.state !== 'running') return;
    return window.insectoids.hive.onEvent((ev) => {
      if (ev.type !== 'install-output' || ev.engineId !== e.id) return;
      setLines((prev) => [...prev, ...ev.lines].slice(-MAX_LINES));
    });
  }, [phase.state, e.id]);

  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(t);
  }, [copied]);

  if (!install) return null;

  const run = async (): Promise<void> => {
    if (running) return;
    setRunning(e.id);
    setLines([]);
    setPhase({ state: 'running' });
    try {
      const result = await window.insectoids.hive.engineInstall(e.id);
      setPhase({ state: 'done', result });
      await refresh();
    } catch (err) {
      setPhase({ state: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setRunning(null);
    }
  };

  const onOpenChange = (next: boolean): void => {
    // The dialog stays open while the command runs: closing it would hide a process that is still working.
    if (!next && phase.state === 'running') return;
    setOpen(next);
    if (next) {
      setPhase({ state: 'ask' });
      setLines([]);
    }
  };

  const otherRunning = busyId !== null && busyId !== e.id;
  const failedOrNotRun = phase.state === 'done' && phase.result.status !== 'installed';

  return (
    <>
      {offer ? (
        <div className="flex flex-wrap items-center gap-2">
      <Button
        data-testid="engine-install"
        disabled={busyId !== null}
        onClick={() => onOpenChange(true)}
        title={otherRunning ? 'Another install is running. One at a time.' : undefined}
        type="button"
      >
        <Download aria-hidden="true" className="size-4" />
        {verb} {e.name}…
      </Button>
          <span className="text-xs text-muted">or copy the command and run it yourself:</span>
        </div>
      ) : null}
      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent closeLabel="Close" data-testid="install-dialog" showClose={phase.state !== 'running'}>
          <DialogHeader>
            <DialogTitle>
              {verb} {e.name}
            </DialogTitle>
            <DialogDescription>
              This runs {e.vendor}&rsquo;s own {verb.toLowerCase()} command on this computer, exactly as shown. Nothing runs until you say so.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">The command</span>
            <div className="flex items-stretch gap-2">
              <code
                className="flex min-h-10 min-w-0 flex-1 items-center whitespace-pre-wrap break-all rounded-[10px] border border-line bg-ground px-3 py-2 font-mono text-xs text-text"
                data-testid="install-command"
              >
                {install.command}
              </code>
              <Button
                aria-label={`Copy: ${install.command}`}
                onClick={() => void copyText(install.command).then((ok) => setCopied(ok))}
                size="sm"
                type="button"
                variant="outline"
              >
                {copied ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="m-0 text-xs text-muted">{install.note}</p>
          </div>

          {phase.state === 'ask' ? (
            <>
              <p className="m-0 text-sm">
                It installs {e.name} for your user account, using the internet. When it finishes, the app checks {e.name} again. You can
                also copy the command and run it yourself instead.
              </p>
              <p className="m-0 font-semibold">Run this command?</p>
              <DialogFooter>
                <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
                  Cancel
                </Button>
                <Button data-testid="install-run" disabled={otherRunning} onClick={() => void run()} type="button">
                  <TerminalSquare aria-hidden="true" className="size-4" />
                  Run it
                </Button>
              </DialogFooter>
              {otherRunning ? <p className="m-0 text-xs text-muted">Another install is running. One at a time.</p> : null}
            </>
          ) : null}

          {phase.state !== 'ask' ? (
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-2 text-xs font-medium text-muted">
                {phase.state === 'running' ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" /> : null}
                {phase.state === 'running' ? 'Running… (read-only output)' : 'Output'}
              </span>
              <pre
                aria-label={`${e.name} install output`}
                className="m-0 max-h-56 min-h-20 overflow-auto whitespace-pre-wrap break-all rounded-[10px] border border-line bg-ground p-3 font-mono text-xs text-text"
                data-testid="install-output"
                ref={outputRef}
                tabIndex={0}
              >
                {lines.length ? lines.join('\n') : phase.state === 'running' ? 'Waiting for output…' : 'No output.'}
              </pre>
              <span aria-live="polite" className="sr-only">
                {phase.state === 'running' ? `Installing ${e.name}…` : phase.state === 'done' ? phase.result.message : ''}
              </span>
            </div>
          ) : null}

          {phase.state === 'done' ? (
            <div data-status={phase.result.status} data-testid="install-result">
              {phase.result.status === 'installed' ? (
                <InlineAlert
                  message={`${phase.result.message}${phase.result.version ? ` (version ${phase.result.version})` : ''}`}
                  title={`${e.name} is installed`}
                  tone="ok"
                />
              ) : phase.result.status === 'not-run' ? (
                <InlineAlert message={phase.result.message} title="Nothing was run" tone="waiting" />
              ) : (
                <InlineAlert
                  message={`${phase.result.message}${phase.result.exitCode !== null ? ` (exit code ${phase.result.exitCode})` : ''}`}
                  title="The install didn't finish"
                  tone="error"
                />
              )}
            </div>
          ) : null}
          {phase.state === 'error' ? (
            <div data-status="error" data-testid="install-result">
              <InlineAlert message={phase.message} title="The install couldn't start" tone="error" />
            </div>
          ) : null}

          {failedOrNotRun || phase.state === 'error' ? (
            <p className="m-0 text-xs text-muted">Copy the command to run it yourself in a terminal, then come back: the app checks {e.name} again on its own.</p>
          ) : null}

          {phase.state === 'done' || phase.state === 'error' ? (
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
                Close
              </Button>
            </DialogFooter>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
