import type { DigestBadge } from '@insectoids/shared';
import { Sunrise } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNow } from '@/components/hive/useNow';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { whenWords } from '@/components/cadence/cadence-words';
import { runCommand, useHive } from '@/lib/hive-store';
import { cn } from '@/lib/utils';
import { AwayDigest } from './AwayDigest';
import { useDigest } from './useDigest';

/**
 * The "while you were away" dialog (Cadence 05-D8; App 07; Phase 3 B1), mounted once in the app shell.
 * - Opens by itself when the snapshot's `digest.unseen` is true and the user is arriving: when the app opens, or when
 *   the window is shown again from the tray or restored (main's `window-shown` push). Never in the middle of use, and
 *   not on mere focus changes (switching apps, which also fire as test windows come and go on macOS): then the
 *   top-bar dot shows instead. At most once per unseen period (since +
 *   headline) per renderer session.
 * - Never steals focus from typing: while an input or textarea has focus it waits until that focus leaves.
 * - "Got it" marks the digest seen; "Later" (or Escape, or the close button) only closes it, so the badge stays.
 * - `openAwayDigest()` opens it from anywhere (the top-bar button).
 */

const OPEN_EVENT = 'insectoids:open-digest';

/** Open the "While you were away" dialog from anywhere. */
export function openAwayDigest(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

/** Unseen periods already shown (opened by itself or by hand) in this renderer session. */
const shownThisSession = new Set<string>();
const periodKey = (b: DigestBadge): string => `${b.since}|${b.headline ?? ''}`;

/** True while the user is typing somewhere (the goal composer, a form field). */
function isTyping(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(el.type);
  return el instanceof HTMLSelectElement;
}

export function AwayDigestDialog() {
  const { snapshot } = useHive();
  const badge = snapshot?.digest ?? null;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  const badgeRef = useRef<DigestBadge | null>(null);
  const leavingRef = useRef(false);
  const now = useNow(30_000);
  const digest = useDigest(open);

  useEffect(() => {
    badgeRef.current = badge;
  });
  // Only a new unseen period re-arms the check (not every snapshot refresh).
  const watchKey = badge?.unseen ? periodKey(badge) : null;

  // "The user is arriving": true when the app opens, and again whenever the window is shown from the tray or restored. The dialog only opens by itself on arrival, never in the middle of use: unattended work that finishes
  // while the user is in the app shows as the top-bar dot instead.
  const arrivingRef = useRef(true);
  const firstBadgeRef = useRef(true);
  useEffect(() => {
    if (!badge || !firstBadgeRef.current) return;
    firstBadgeRef.current = false;
    // Nothing waiting when the app opened: this arrival is used up.
    if (!badge.unseen) arrivingRef.current = false;
  }, [badge]);
  useEffect(() => {
    // Only main's signal counts as arriving: the window shown from the tray or restored. The page's own focus and
    // visibility events don't: they also fire while the user is busy elsewhere, and on macOS as other windows come and go.
    const arriving = (): void => {
      arrivingRef.current = true;
    };
    const off = window.insectoids.hive.onEvent((e) => {
      if (e.type === 'window-shown') arriving();
      // A click on a notification or a tray item opens a screen on purpose: the digest doesn't cover it this time.
      if (e.type === 'open-screen') arrivingRef.current = false;
    });
    return () => {
      off();
    };
  }, []);

  // Open by itself when there is something unseen and the user is arriving (app opened, window back in front).
  useEffect(() => {
    if (watchKey === null) return;
    const check = (): void => {
      const b = badgeRef.current;
      if (!b?.unseen || !arrivingRef.current) return;
      const key = periodKey(b);
      if (shownThisSession.has(key)) return;
      if (document.visibilityState !== 'visible') return;
      if (isTyping()) return; // `focusout` checks again once the field loses focus.
      arrivingRef.current = false;
      shownThisSession.add(key);
      setMarkError(null);
      setOpen(true);
    };
    // A short wait lets the screen settle (and the composer take focus) before deciding.
    const timer = setTimeout(check, 300);
    const later = (): void => void setTimeout(check, 0);
    document.addEventListener('visibilitychange', later);
    window.addEventListener('focus', later);
    document.addEventListener('focusout', later);
    const off = window.insectoids.hive.onEvent((e) => {
      // A little later than the page's own events, so an `open-screen` that comes with the same click wins.
      if (e.type === 'window-shown') void setTimeout(check, 400);
    });
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', later);
      window.removeEventListener('focus', later);
      document.removeEventListener('focusout', later);
      off();
    };
  }, [watchKey]);

  // Opened by hand (top bar): this period counts as shown, so it won't pop up again by itself.
  useEffect(() => {
    const onOpen = (): void => {
      const b = badgeRef.current;
      if (b?.unseen) shownThisSession.add(periodKey(b));
      setMarkError(null);
      setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  const unseen = digest.view?.unseen ?? badge?.unseen ?? false;
  const since = digest.view?.since ?? badge?.since ?? null;

  const gotIt = async (): Promise<void> => {
    if (!unseen) {
      setOpen(false);
      return;
    }
    setBusy(true);
    const r = await runCommand({ type: 'markDigestSeen' });
    setBusy(false);
    if (r.ok) setOpen(false);
    else setMarkError(r.error);
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent
        className="max-w-2xl"
        closeLabel="Close"
        data-testid="away-digest"
        data-unseen={unseen}
        onCloseAutoFocus={(e) => {
          // Leaving for a goal or Approvals: let that screen take focus instead of the button that opened this.
          if (leavingRef.current) {
            e.preventDefault();
            leavingRef.current = false;
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>While you were away</DialogTitle>
          <DialogDescription>
            {since ? `What the hive did on its own since ${whenWords(since, now)}.` : 'What the hive did on its own.'}
          </DialogDescription>
        </DialogHeader>

        {digest.error ? (
          <InlineAlert actions={[{ label: 'Try again', onClick: digest.retry, primary: true }]} message={digest.error} title="Couldn't read the digest" tone="error" />
        ) : null}
        {digest.view ? (
          <AwayDigest
            now={now}
            onLeave={() => {
              leavingRef.current = true;
              setOpen(false);
            }}
            view={digest.view}
          />
        ) : !digest.error ? (
          <div aria-busy="true" className="flex flex-col gap-2" role="status">
            {badge?.headline ? <p className="m-0 text-[15px] font-medium">{badge.headline}</p> : null}
            <p className="m-0 text-sm text-muted">Reading what happened…</p>
          </div>
        ) : null}

        {markError ? <InlineAlert message={markError} onDismiss={() => setMarkError(null)} title="Couldn't mark it as read" tone="error" /> : null}

        <DialogFooter>
          {unseen ? (
            <Button onClick={() => setOpen(false)} variant="outline">
              Later
            </Button>
          ) : null}
          <Button disabled={busy} onClick={() => void gotIt()}>
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The top-bar way back to the digest any time, with a dot while something is unseen. */
export function AwayDigestButton({ className }: { className?: string }) {
  const { snapshot } = useHive();
  if (!snapshot) return null;
  const unseen = snapshot.digest.unseen;
  return (
    <button
      className={cn(
        'relative inline-flex min-h-10 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[13px] text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-honey',
        unseen && 'text-text',
        className,
      )}
      data-testid="away-digest-button"
      data-unseen={unseen}
      onClick={openAwayDigest}
      title={snapshot.digest.headline ?? 'While you were away'}
      type="button"
    >
      <Sunrise aria-hidden="true" size={14} />
      While you were away
      {unseen ? (
        <>
          <span aria-hidden="true" className="size-2 rounded-full bg-honey" data-testid="away-digest-dot" />
          <span className="sr-only"> (new)</span>
        </>
      ) : null}
    </button>
  );
}
