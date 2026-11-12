/**
 * Source: Kokonut UI — Empty State v1 (@kokonutui, MIT) https://kokonutui.com
 * Adapted for The Insectoids: our tokens (honey tile instead of the purple gradient), strict TypeScript,
 * and a general API instead of the demo project list. Kept: the fanned-cards drawing that lifts and
 * spreads when the main action is hovered or focused ("primed"), and the staggered reveal of the text.
 * App 07: "an empty state that becomes the first item".
 */
import type { LucideIcon } from 'lucide-react';
import { MotionConfig, motion } from 'motion/react';
import { type ReactNode, useState } from 'react';
import { cn } from '@/lib/utils';

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
  icon?: LucideIcon;
}

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  /** Icon on the front card of the drawing. */
  icon: LucideIcon;
  primary?: EmptyStateAction;
  secondary?: EmptyStateAction;
  className?: string;
}

const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const MORPH = { type: 'spring', stiffness: 380, damping: 34 } as const;
const REVEAL = {
  hidden: { opacity: 0, y: 6, filter: 'blur(2px)' },
  shown: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.3, ease: EASE_OUT } },
};

/** Two blank cards fanned behind the one the main action will make. */
function Drawing({ icon: Icon, primed }: { icon: LucideIcon; primed: boolean }) {
  const spread = primed ? 1.35 : 1;
  return (
    <div aria-hidden="true" className="relative h-[92px] w-[150px]">
      {[-1, 1].map((side) => (
        <motion.div
          animate={{ rotate: side * 7.5 * spread, x: side * 22 * spread, y: 6 }}
          className="absolute inset-x-4 top-2 h-[76px] rounded-2xl border border-line bg-surface-2"
          initial={{ rotate: 0, x: 0, y: 0 }}
          key={side}
          transition={MORPH}
        />
      ))}
      <motion.div
        animate={{ y: primed ? -5 : 0 }}
        className="absolute inset-x-4 top-0 flex h-[80px] flex-col justify-between rounded-2xl border border-dashed border-honey/50 bg-surface p-3 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.4)]"
        transition={MORPH}
      >
        <span className="flex size-7 items-center justify-center rounded-lg bg-honey text-honey-ink">
          <Icon className="size-4" />
        </span>
        <span className="flex flex-col gap-1.5">
          <span className="h-1.5 w-14 rounded-full bg-line" />
          <span className="h-1.5 w-9 rounded-full bg-surface-2" />
        </span>
      </motion.div>
    </div>
  );
}

export function EmptyState({ title, description, icon, primary, secondary, className }: EmptyStateProps) {
  const [primed, setPrimed] = useState(false);
  return (
    <MotionConfig reducedMotion="user">
      <div className={cn('flex flex-col items-center justify-center px-8 py-8 text-center', className)}>
        <Drawing icon={icon} primed={primed} />
        <motion.div animate="shown" initial="hidden" transition={{ staggerChildren: 0.05, delayChildren: 0.1 }}>
          <motion.h2 className="m-0 mt-6 font-display text-xl font-semibold tracking-tight" variants={REVEAL}>
            {title}
          </motion.h2>
          {description && (
            <motion.div className="mx-auto mt-1.5 max-w-[460px] text-[13.5px] leading-snug text-muted" variants={REVEAL}>
              {description}
            </motion.div>
          )}
          {(primary || secondary) && (
            <motion.div className="mt-5 flex flex-wrap items-center justify-center gap-2" variants={REVEAL}>
              {primary && (
                <button
                  className="inline-flex min-h-10 items-center gap-1.5 rounded-full bg-honey px-4 text-[13px] font-semibold text-honey-ink transition-colors duration-150 hover:bg-honey/85"
                  onBlur={() => setPrimed(false)}
                  onClick={primary.onClick}
                  onFocus={() => setPrimed(true)}
                  onPointerEnter={(e) => e.pointerType === 'mouse' && setPrimed(true)}
                  onPointerLeave={() => setPrimed(false)}
                  type="button"
                >
                  {primary.icon && <primary.icon aria-hidden="true" className="size-4" />}
                  {primary.label}
                </button>
              )}
              {secondary && (
                <button
                  className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-line bg-surface px-4 text-[13px] font-semibold transition-colors duration-150 hover:bg-surface-2"
                  onClick={secondary.onClick}
                  type="button"
                >
                  {secondary.icon && <secondary.icon aria-hidden="true" className="size-4" />}
                  {secondary.label}
                </button>
              )}
            </motion.div>
          )}
        </motion.div>
      </div>
    </MotionConfig>
  );
}

export default EmptyState;
