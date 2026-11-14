/**
 * Source: Kokonut UI — AI Tool Approval v1.0.0 (@kokonutui, MIT) https://kokonutui.com
 * Adapted for The Insectoids' approval cards (plans, risky actions, merges, …): our tokens, strict
 * TypeScript, no demo run. Kept from the original: the approval card layout (icon, title, source, a
 * "Destructive" tag), Escape denies, destructive items need a press-and-hold (Kokonut Hold Button here),
 * the card's enter/exit motion, and decided items folded to one quiet trace line.
 */
import { Check, type LucideIcon, X } from 'lucide-react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { type ReactNode, useId, useRef, useState } from 'react';
import { HoldButton } from '@/components/kokonutui/hold-button';
import { cn } from '@/lib/utils';

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

export interface ApprovalCardProps {
  id: string;
  icon: LucideIcon;
  /** What kind of decision, in plain words ("Plan", "Merge"). */
  kindLabel: string;
  title: string;
  /** Who is asking ("Queen", an insect id). */
  from: string;
  whyItNeedsYou: string;
  ifYouSayYes: string;
  destructive: boolean;
  /** Extra content between the reasons and the buttons (e.g. the plan's waves). */
  children?: ReactNode;
  onApprove: () => Promise<void> | void;
  onDeny: () => Promise<void> | void;
  /** Optional third action, e.g. "Adjust" for a plan. */
  extraAction?: { label: string; hint: string; onClick: () => void } | undefined;
  approveLabel?: string;
  className?: string;
  /**
   * Called after Approve or Deny finished while focus was in this card (or already lost with it): the card is
   * about to leave, so the caller moves focus somewhere that stays (WCAG 2.4.3).
   */
  onSettled?: (() => void) | undefined;
}

/** A waiting decision. Approve / Deny; destructive ones need a hold. */
export function ApprovalCard({
  id,
  icon: Icon,
  kindLabel,
  title,
  from,
  whyItNeedsYou,
  ifYouSayYes,
  destructive,
  children,
  onApprove,
  onDeny,
  extraAction,
  approveLabel = 'Approve',
  className,
  onSettled,
}: ApprovalCardProps) {
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const act = async (fn: () => Promise<void> | void) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      const el = document.activeElement;
      if (!el || el === document.body || cardRef.current?.contains(el)) onSettled?.();
    }
  };

  return (
    <MotionConfig reducedMotion="user">
      <motion.section
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        aria-labelledby={titleId}
        className={cn('rounded-[14px] border border-st-waiting/40 bg-surface p-3.5 outline-none', className)}
        data-approval-id={id}
        initial={{ opacity: 0, y: 8, filter: 'blur(2px)' }}
        ref={cardRef}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) void act(onDeny);
        }}
        tabIndex={-1}
        transition={{ duration: 0.22, ease: EASE_OUT }}
      >
        <header className="mb-2.5 flex flex-wrap items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-st-waiting/15 text-st-waiting">
            <Icon aria-hidden="true" className="size-4" />
          </span>
          <h3 className="m-0 text-sm font-semibold" id={titleId}>
            {title}
          </h3>
          <span className="text-xs text-muted">
            {kindLabel} · from {from}
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-st-waiting">
            <span aria-hidden="true" className="size-[7px] rounded-full bg-st-waiting" />
            Needs you
          </span>
          {destructive && (
            <span className="rounded-md bg-st-blocked/15 px-1.5 py-0.5 text-[11px] font-semibold text-st-blocked">Destructive</span>
          )}
        </header>
        <dl className="m-0 grid gap-2 text-[13px]">
          <div>
            <dt className="text-xs text-muted">Why it needs you</dt>
            <dd className="m-0">{whyItNeedsYou}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">If you say yes</dt>
            <dd className="m-0">{ifYouSayYes}</dd>
          </div>
        </dl>
        {children}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {destructive ? <span className="text-xs text-muted">Press and hold to approve</span> : <span className="text-xs text-muted">Esc denies</span>}
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {extraAction && (
              <button
                className="min-h-10 rounded-[10px] px-3 text-sm text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text disabled:opacity-50"
                disabled={busy}
                onClick={extraAction.onClick}
                title={extraAction.hint}
                type="button"
              >
                {extraAction.label}
              </button>
            )}
            <button
              className="min-h-10 rounded-[10px] border border-line px-3 text-sm transition-colors duration-150 hover:bg-surface-2 disabled:opacity-50"
              disabled={busy}
              onClick={() => void act(onDeny)}
              type="button"
            >
              Deny
            </button>
            {destructive ? (
              <HoldButton
                aria-label={`${approveLabel}: press and hold to confirm`}
                completeLabel="Approved"
                disabled={busy}
                icon={Check}
                onHoldComplete={() => void act(onApprove)}
                resetAfter={0}
                variant="danger"
              >
                Hold to {approveLabel.toLowerCase()}
              </HoldButton>
            ) : (
              <button
                className="min-h-10 rounded-[10px] bg-honey px-3.5 text-sm font-semibold text-honey-ink transition-colors duration-150 hover:bg-honey/85 disabled:opacity-50"
                disabled={busy}
                onClick={() => void act(onApprove)}
                type="button"
              >
                {approveLabel}
              </button>
            )}
          </div>
        </div>
      </motion.section>
    </MotionConfig>
  );
}

/** A decided item, folded to one quiet line (approved ✓ or denied ✗). */
export function DecisionLine({ title, approved, at }: { title: string; approved: boolean; at?: string | undefined }) {
  return (
    <AnimatePresence initial={false}>
      <motion.div
        animate={{ opacity: 1, height: 'auto' }}
        className="flex items-center gap-2.5 py-1 text-[13px] text-muted"
        initial={{ opacity: 0, height: 0 }}
        transition={{ duration: 0.24, ease: EASE_OUT }}
      >
        {approved ? <Check aria-hidden="true" className="size-3.5 text-st-done" /> : <X aria-hidden="true" className="size-3.5 text-st-blocked" />}
        <span>{approved ? 'Approved' : 'Denied'}</span>
        <span className={cn('min-w-0 truncate', !approved && 'line-through')}>{title}</span>
        {at && <span className="ml-auto shrink-0 text-xs">{at}</span>}
      </motion.div>
    </AnimatePresence>
  );
}
