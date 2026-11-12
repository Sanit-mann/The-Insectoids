/**
 * Source: Kokonut UI — Inline Alert v1.0.0 (@kokonutui, MIT) https://kokonutui.com
 * Adapted for The Insectoids: our status tokens, strict TypeScript, and a general API instead of the
 * deploy-checks demo. Kept: the tone wipe (the background sweeps to the new tone when the state changes),
 * the icon swap, the crossfading title/message, alert vs status roles, and the dismiss button.
 *
 * Used for the "states every screen handles" (App 07): errors with a re-run, an engine that isn't ready,
 * and "waiting for you".
 */
import { CircleAlert, CircleCheck, Hourglass, LoaderCircle, X } from 'lucide-react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type AlertTone = 'error' | 'waiting' | 'ok';

export interface AlertAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

export interface InlineAlertProps {
  tone: AlertTone;
  title: string;
  message?: ReactNode;
  /** Shows a spinner instead of the tone icon (e.g. while a check re-runs). */
  busy?: boolean;
  actions?: AlertAction[];
  onDismiss?: (() => void) | undefined;
  className?: string;
}

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const TONE: Record<AlertTone, { ground: string; icon: string }> = {
  error: { ground: 'border-st-blocked/40 bg-st-blocked/10', icon: 'bg-st-blocked' },
  waiting: { ground: 'border-st-waiting/40 bg-st-waiting/10', icon: 'bg-st-waiting' },
  ok: { ground: 'border-st-done/40 bg-st-done/10', icon: 'bg-st-done' },
};

function ToneIcon({ tone, busy }: { tone: AlertTone; busy: boolean }) {
  const cls = 'size-4';
  if (busy) return <LoaderCircle aria-hidden="true" className={cn(cls, 'motion-safe:animate-spin')} />;
  if (tone === 'ok') return <CircleCheck aria-hidden="true" className={cls} />;
  if (tone === 'waiting') return <Hourglass aria-hidden="true" className={cls} />;
  return <CircleAlert aria-hidden="true" className={cls} />;
}

export function InlineAlert({ tone, title, message, busy = false, actions = [], onDismiss, className }: InlineAlertProps) {
  return (
    <MotionConfig reducedMotion="user">
      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className={cn('relative w-full overflow-hidden rounded-[14px] text-text', className)}
        initial={{ opacity: 0, y: 6 }}
        role={tone === 'error' ? 'alert' : 'status'}
        transition={{ duration: 0.25, ease: EASE_OUT }}
      >
        {/* The new tone wipes in from the left whenever the tone changes. */}
        <AnimatePresence initial={false}>
          <motion.div
            animate={{ clipPath: 'inset(0% 0% 0% 0%)' }}
            aria-hidden="true"
            className={cn('absolute inset-0 rounded-[14px] border', TONE[tone].ground)}
            exit={{ opacity: 0, transition: { duration: 0.6 } }}
            initial={{ clipPath: 'inset(0% 100% 0% 0%)' }}
            key={tone}
            transition={{ duration: 0.6, ease: EASE_OUT }}
          />
        </AnimatePresence>
        <div className="relative flex gap-3 p-4">
          <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full text-honey-ink transition-colors duration-300', TONE[tone].icon)}>
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, scale: 0.8, filter: 'blur(2px)' }}
                initial={{ opacity: 0, scale: 0.8, filter: 'blur(2px)' }}
                key={busy ? 'busy' : tone}
                transition={{ duration: 0.2, ease: EASE_OUT }}
              >
                <ToneIcon busy={busy} tone={tone} />
              </motion.span>
            </AnimatePresence>
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex items-start justify-between gap-3">
              <div aria-live="polite" className="relative min-w-0">
                <AnimatePresence initial={false} mode="popLayout">
                  <motion.div
                    animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                    exit={{ opacity: 0, y: -4, filter: 'blur(2px)' }}
                    initial={{ opacity: 0, y: 4, filter: 'blur(2px)' }}
                    key={title}
                    transition={{ duration: 0.2, ease: EASE_OUT }}
                  >
                    <p className="m-0 text-[14.5px] font-semibold leading-5">{title}</p>
                    {message && <div className="mt-0.5 text-[13px] text-muted">{message}</div>}
                  </motion.div>
                </AnimatePresence>
              </div>
              {onDismiss && (
                <button
                  aria-label="Dismiss"
                  className="-mt-1 -mr-1 flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
                  onClick={onDismiss}
                  type="button"
                >
                  <X aria-hidden="true" className="size-4" />
                </button>
              )}
            </div>
            {actions.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pt-3">
                {actions.map((a) => (
                  <button
                    className={cn(
                      'inline-flex min-h-10 items-center gap-1.5 rounded-[10px] px-3.5 text-[13px] font-semibold transition-colors duration-150 disabled:opacity-50',
                      a.primary ? 'bg-honey text-honey-ink hover:bg-honey/85' : 'border border-line bg-surface text-text hover:bg-surface-2',
                    )}
                    disabled={busy}
                    key={a.label}
                    onClick={a.onClick}
                    type="button"
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </MotionConfig>
  );
}

export default InlineAlert;
