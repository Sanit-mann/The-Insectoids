/**
 * Source: Kokonut UI — Hold Button v2.0.0 (@dorianbaffier, MIT) https://kokonutui.com
 * Adapted for The Insectoids: our colour tokens (honey / danger instead of Tailwind palettes),
 * no demo icons or labels, strict TypeScript, named export.
 *
 * Press and hold to confirm (App 07 principle 2: destructive approvals use hold-to-approve).
 * The fill tracks the hold and drains back on an early release; Space/Enter hold works too.
 *
 * API:
 *   <HoldButton variant="honey" | "danger" icon={LucideIcon} onHoldComplete={() => …}
 *     holdDuration={1200} holdingLabel="Keep holding" completeLabel="Approved" resetAfter={1800}>
 *     Hold to approve
 *   </HoldButton>
 * `onHoldComplete` fires once per full hold; a click or early release never calls it.
 */
import { cva, type VariantProps } from 'class-variance-authority';
import type { LucideIcon } from 'lucide-react';
import {
  AnimatePresence,
  type AnimationPlaybackControls,
  MotionConfig,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from 'motion/react';
import { type ButtonHTMLAttributes, type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

const holdButtonVariants = cva(
  [
    'group/hold relative inline-flex min-h-10 min-w-40 touch-none select-none items-center justify-center overflow-hidden rounded-[10px] px-4 text-sm font-semibold',
    'border [-webkit-touch-callout:none]',
    'transition-[background-color,border-color,color] duration-150 ease-out',
    'disabled:pointer-events-none disabled:opacity-50',
  ],
  {
    variants: {
      variant: {
        honey: [
          'border-honey/50 bg-honey/10 text-honey-text hover:bg-honey/15',
          'data-complete:border-honey data-complete:bg-honey data-complete:text-honey-ink',
        ],
        danger: [
          'border-st-blocked/50 bg-st-blocked/10 text-st-blocked hover:bg-st-blocked/15',
          'data-complete:border-st-blocked data-complete:bg-st-blocked data-complete:text-honey-ink',
        ],
      },
    },
    defaultVariants: { variant: 'honey' },
  },
);

export interface HoldButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>, VariantProps<typeof holdButtonVariants> {
  /** Idle label, e.g. "Hold to approve". */
  children: ReactNode;
  /** Icon shown before the idle label. */
  icon?: LucideIcon | undefined;
  /** How long (ms) the button has to be held. */
  holdDuration?: number;
  /** Label while holding. */
  holdingLabel?: ReactNode;
  /** Label once the hold completes. */
  completeLabel?: ReactNode;
  /** How long (ms) the complete state shows before resetting. 0 keeps it. */
  resetAfter?: number;
  /** Called once the button has been held for the full `holdDuration`. */
  onHoldComplete?: (() => void) | undefined;
}

type Phase = 'idle' | 'holding' | 'complete';

const HOLD_KEYS = new Set([' ', 'Enter']);
const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const LABEL_TRANSITION = { duration: 0.2, ease: EASE_OUT };
/** Time (ms) a full fill takes to drain after an early release. */
const DRAIN_MS = 300;
/** The holding label waits this long (ms), so a quick tap doesn't flicker it. */
const LABEL_DELAY_MS = 150;

function DrawnCheck() {
  return (
    <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 16 16">
      <motion.path
        animate={{ pathLength: 1 }}
        d="M3.5 8.5 6.5 11.5 12.5 4.5"
        initial={{ pathLength: 0 }}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        transition={{ duration: 0.3, delay: 0.1, ease: EASE_OUT }}
      />
    </svg>
  );
}

export function HoldButton({
  className,
  variant = 'honey',
  icon: Icon,
  holdDuration = 1200,
  holdingLabel = 'Keep holding',
  completeLabel = 'Done',
  resetAfter = 1800,
  onHoldComplete,
  children,
  type = 'button',
  disabled,
  onPointerDown,
  onPointerUp,
  onPointerLeave,
  onPointerCancel,
  onKeyDown,
  onKeyUp,
  onBlur,
  ...props
}: HoldButtonProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [showHoldingLabel, setShowHoldingLabel] = useState(false);
  const labelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phaseRef = useRef<Phase>('idle');
  const progress = useMotionValue(0);
  const animationRef = useRef<AnimationPlaybackControls | null>(null);
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onHoldCompleteRef = useRef(onHoldComplete);
  const shouldReduceMotion = useReducedMotion();
  const clipPath = useTransform(progress, (p) => `inset(0 ${(1 - p) * 100}% 0 0)`);

  useEffect(() => {
    onHoldCompleteRef.current = onHoldComplete;
  }, [onHoldComplete]);

  useEffect(
    () => () => {
      animationRef.current?.stop();
      if (labelTimerRef.current) clearTimeout(labelTimerRef.current);
      if (resetRef.current) clearTimeout(resetRef.current);
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    },
    [],
  );

  const updatePhase = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
    if (labelTimerRef.current) {
      clearTimeout(labelTimerRef.current);
      labelTimerRef.current = null;
    }
    if (next === 'holding') labelTimerRef.current = setTimeout(() => setShowHoldingLabel(true), LABEL_DELAY_MS);
    else setShowHoldingLabel(false);
  };

  const complete = () => {
    updatePhase('complete');
    onHoldCompleteRef.current?.();
    if (resetAfter > 0) {
      resetRef.current = setTimeout(() => {
        resetRef.current = null;
        progress.set(0);
        updatePhase('idle');
      }, resetAfter);
    }
  };

  const clearHoldTimer = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const startHold = () => {
    if (phaseRef.current !== 'idle' || disabled) return;
    updatePhase('holding');
    animationRef.current?.stop();
    // Picks up from wherever a previous drain left the fill.
    const remaining = (1 - progress.get()) * holdDuration;
    animationRef.current = animate(progress, 1, { duration: remaining / 1000, ease: 'linear' });
    // Completion follows the clock, not the fill: a hidden or busy window can pause animation frames,
    // and the hold must still finish on time (Insectoids change).
    clearHoldTimer();
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      if (phaseRef.current === 'holding') {
        progress.set(1);
        complete();
      }
    }, remaining);
  };

  const endHold = () => {
    if (phaseRef.current !== 'holding') return;
    clearHoldTimer();
    updatePhase('idle');
    animationRef.current?.stop();
    animationRef.current = animate(progress, 0, {
      duration: shouldReduceMotion ? 0 : (progress.get() * DRAIN_MS) / 1000,
      ease: EASE_OUT,
    });
  };

  const handlePointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    onPointerDown?.(e);
    if (e.button !== 0) return;
    // Touch pointers are captured implicitly; release so pointerleave cancels the hold.
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    startHold();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(e);
    if (HOLD_KEYS.has(e.key)) {
      // Stops Enter from firing click and Space from scrolling.
      e.preventDefault();
      if (!e.repeat) startHold();
    }
  };

  const handleKeyUp = (e: KeyboardEvent<HTMLButtonElement>) => {
    onKeyUp?.(e);
    if (HOLD_KEYS.has(e.key)) endHold();
  };

  let label: ReactNode = children;
  if (phase === 'holding' && showHoldingLabel) label = holdingLabel;
  else if (phase === 'complete') label = completeLabel;
  const labelKey = phase === 'holding' && !showHoldingLabel ? 'idle' : phase;

  return (
    <MotionConfig reducedMotion="user">
      <button
        {...props}
        aria-disabled={phase === 'complete' || undefined}
        className={cn(holdButtonVariants({ variant }), className)}
        data-complete={phase === 'complete' || undefined}
        data-holding={phase === 'holding' || undefined}
        disabled={disabled}
        onBlur={(e) => {
          onBlur?.(e);
          endHold();
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onPointerCancel={(e) => {
          onPointerCancel?.(e);
          endHold();
        }}
        onPointerDown={handlePointerDown}
        onPointerLeave={(e) => {
          onPointerLeave?.(e);
          endHold();
        }}
        onPointerUp={(e) => {
          onPointerUp?.(e);
          endHold();
        }}
        type={type}
      >
        {/* The fill is the button's ink at low strength, revealed left to right. */}
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-current/20 transition-opacity duration-150 group-data-complete/hold:opacity-0"
          style={{ clipPath }}
        />
        <span className="relative flex items-center justify-center overflow-hidden">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              className="inline-flex items-center gap-2 whitespace-nowrap"
              exit={{ opacity: 0, y: -10, filter: 'blur(2px)' }}
              initial={{ opacity: 0, y: 10, filter: 'blur(2px)' }}
              key={labelKey}
              transition={LABEL_TRANSITION}
            >
              {labelKey === 'complete' ? <DrawnCheck /> : Icon ? <Icon aria-hidden="true" className="size-4" /> : null}
              {label}
            </motion.span>
          </AnimatePresence>
        </span>
        <span aria-live="polite" className="sr-only">
          {phase === 'complete' ? completeLabel : ''}
        </span>
      </button>
    </MotionConfig>
  );
}

export default HoldButton;
