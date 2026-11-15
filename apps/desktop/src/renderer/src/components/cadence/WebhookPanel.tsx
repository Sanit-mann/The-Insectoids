import type { CadenceView, WebhookInfo, WebhookSecretResult } from '@insectoids/shared';
import { Check, ChevronRight, Copy, KeyRound, Radio, RefreshCw, TriangleAlert, Webhook } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { useHive } from '@/lib/hive-store';
import { cn } from '@/lib/utils';
import { TRUST } from './cadence-words';

/**
 * A webhook cadence's address and secret (Phase 3 A4; Cadence 05-D2, D4). The secret lives in main's Vault and only
 * ever reaches the clipboard ("Copy secret", "New secret"); this panel never sees it. The URLs are not secret, so
 * they are copied here with the browser clipboard.
 */

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function UrlRow({ label, hint, url, testId }: { label: string; hint: string; url: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const labelId = useId();

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = () => {
    navigator.clipboard
      .writeText(url)
      .then(() => {
        setFailed(false);
        setCopied(true);
      })
      .catch(() => setFailed(true));
  };

  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-text" id={labelId}>
        {label} <span className="text-xs text-muted">{hint}</span>
      </span>
      <div className="flex items-center gap-2">
        <code aria-labelledby={labelId} className="min-w-0 flex-1 truncate rounded-[10px] border border-line bg-ground px-3 py-2 font-mono text-xs text-text" data-testid={testId} title={url}>
          {url}
        </code>
        <Button aria-label={`Copy the ${label.toLowerCase()}`} onClick={copy} size="sm" type="button" variant="outline">
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
        </Button>
      </div>
      {failed ? <p className="m-0 text-xs text-st-blocked">Couldn&apos;t copy. Select the address and copy it by hand.</p> : null}
    </div>
  );
}

export function WebhookPanel({ cadence }: { cadence: CadenceView }) {
  const { snapshot } = useHive();
  const [info, setInfo] = useState<WebhookInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedHint, setCopiedHint] = useState<string | null | undefined>(undefined);
  const [confirmNew, setConfirmNew] = useState(false);
  const confirmId = useId();
  const trust = cadence.when.type === 'webhook' ? cadence.when.trust : null;

  // Read again on mount and whenever the hive changes (the listener can start, stop or lose its port).
  useEffect(() => {
    let live = true;
    window.insectoids.webhooks
      .info(cadence.id)
      .then((i) => {
        if (live) {
          setInfo(i);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (live) setError(errText(e));
      });
    return () => {
      live = false;
    };
  }, [cadence.id, snapshot]);

  const secret = async (fn: (id: string) => Promise<WebhookSecretResult>) => {
    setBusy(true);
    setConfirmNew(false);
    setCopiedHint(undefined);
    try {
      const r = await fn(cadence.id);
      if (r.ok) {
        setInfo(r.info);
        setError(null);
        setCopiedHint(r.info.secretHint);
      } else setError(r.error);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={`Webhook of ${cadence.name}`} className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4" data-testid="webhook-panel">
      <header className="flex items-center gap-2">
        <Webhook aria-hidden="true" className="size-4 text-honey-text" />
        <h2 className="m-0 font-display text-base font-semibold">Webhook</h2>
        {trust ? <span className="ml-auto text-xs text-muted">Trust: {TRUST[trust].label}</span> : null}
      </header>

      {error ? <InlineAlert message={error} onDismiss={() => setError(null)} title="That didn't work" tone="error" /> : null}
      {info === null && !error ? <p className="m-0 text-sm text-muted">Reading the webhook…</p> : null}

      {info ? (
        <>
          <p className={cn('m-0 flex items-start gap-2 text-sm', info.listening ? 'text-text' : 'text-st-blocked')} data-testid="webhook-status">
            {info.listening ? (
              <Radio aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-st-done" />
            ) : (
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            )}
            <span>
              <span className="font-semibold">{info.listening ? 'Listening.' : 'Not listening.'}</span> {info.status}
            </span>
          </p>

          {!info.vaultAvailable ? (
            <InlineAlert
              message="This computer has no key store, so no secret can be kept. Until there is one, the webhook refuses every call."
              title="No safe place for the secret"
              tone="error"
            />
          ) : null}

          <UrlRow hint="(asks the hive to run this cadence)" label="Run address" testId="webhook-run-url" url={info.runUrl} />
          <UrlRow hint="(only sends a note to the Brain)" label="Note address" testId="webhook-note-url" url={info.noteUrl} />

          <div className="flex flex-col gap-2">
            <p className="m-0 flex items-center gap-2 text-sm text-text">
              <KeyRound aria-hidden="true" className="size-4 text-honey-text" />
              {info.hasSecret ? <span>Secret {info.secretHint ? <span className="font-mono">{info.secretHint}</span> : 'set'}</span> : 'No secret yet. Copy secret makes one.'}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy || !info.vaultAvailable} onClick={() => void secret((id) => window.insectoids.webhooks.copySecret(id))} size="sm" type="button">
                <Copy aria-hidden="true" />
                Copy secret
              </Button>
              <Button
                aria-controls={confirmNew ? confirmId : undefined}
                aria-expanded={confirmNew}
                disabled={busy || !info.vaultAvailable}
                onClick={() => setConfirmNew((v) => !v)}
                size="sm"
                type="button"
                variant="outline"
              >
                <RefreshCw aria-hidden="true" />
                New secret
              </Button>
            </div>
            {confirmNew ? (
              <div className="flex flex-col gap-2 rounded-[10px] border border-st-waiting/40 bg-st-waiting/10 p-3" data-testid="webhook-new-secret-confirm" id={confirmId} role="group" aria-label="Make a new secret?">
                <p className="m-0 flex items-start gap-2 text-sm text-text">
                  <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-st-waiting" />
                  The old secret stops working at once. Apps that call this webhook need the new one.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => void secret((id) => window.insectoids.webhooks.newSecret(id))} size="sm" type="button">
                    Yes, replace the secret
                  </Button>
                  <Button onClick={() => setConfirmNew(false)} size="sm" type="button" variant="outline">
                    Keep the old one
                  </Button>
                </div>
              </div>
            ) : null}
            {copiedHint !== undefined ? (
              <InlineAlert
                message={copiedHint ? `It ends in ${copiedHint}. Anyone with it can call this webhook, so keep it private.` : 'Anyone with it can call this webhook, so keep it private.'}
                onDismiss={() => setCopiedHint(undefined)}
                title="Secret copied. Paste it into the app that calls this webhook."
                tone="ok"
              />
            ) : null}
          </div>

          <details className="group rounded-[10px] border border-line bg-ground px-3 py-2 text-sm">
            <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 rounded outline-none focus-visible:ring-2 focus-visible:ring-honey [&::-webkit-details-marker]:hidden">
              <ChevronRight aria-hidden="true" className="size-4 text-muted transition-transform group-open:rotate-90" />
              How to call it
            </summary>
            <div className="flex flex-col gap-2 pt-2 text-xs text-muted">
              <p className="m-0">Send a POST with the secret. A simple sender can put it in a header:</p>
              <pre aria-label="Example command" className="m-0 overflow-x-auto rounded-[8px] border border-line bg-surface p-2 font-mono text-[11px] text-text" tabIndex={0}>
                {'curl -X POST <run address> \\\n  -H "Authorization: Bearer <your secret>" \\\n  -d "New invoice from Acme"'}
              </pre>
              <p className="m-0">
                Better: sign the body instead of sending the secret. Put <code className="font-mono text-text">X-Insectoids-Signature: sha256=&lt;HMAC-SHA256 of the body&gt;</code>{' '}
                in the header, keyed with the secret (GitHub&apos;s <code className="font-mono text-text">X-Hub-Signature-256</code> works too).
              </p>
              <p className="m-0">Use the note address to only tell the hive something. Bodies up to 64 KB; JSON or plain text.</p>
            </div>
          </details>
        </>
      ) : null}
    </section>
  );
}
