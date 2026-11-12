/**
 * Source: Cult UI — Onboarding (@cult-ui, MIT) https://cult-ui.com
 * Adapted for The Insectoids first-run setup (Onboarding 08):
 * - kept: the compound API (Root / Step / StepIndicator / Header / Navigation), controllable step state
 *   via Radix `useControllableState`, the pill step indicator with progressbar ARIA, and ChoiceGroup
 *   (native radio semantics) for the safety presets;
 * - added: a Skip action (every step but the first can be skipped, 08-D2), a busy state while a step
 *   saves, Enter = Next from anywhere in a step (keyboard-only completion), and our design tokens;
 * - removed: the feature carousel, tips list and sub-step values we don't use; strict TypeScript.
 */
import { useControllableState } from '@radix-ui/react-use-controllable-state';
import {
  type KeyboardEvent,
  type PropsWithChildren,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
} from 'react';
import type * as React from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// ---- step indicator ----------------------------------------------------------------------------

export interface StepIndicatorProps extends React.ComponentPropsWithoutRef<'div'> {
  /** Current step (1-based). */
  currentStep: number;
  totalSteps: number;
  /** Optional names, read out with the step number. */
  labels?: readonly string[];
}

export function StepIndicator({ currentStep, totalSteps, labels, className, ...props }: StepIndicatorProps) {
  const label = labels?.[currentStep - 1];
  return (
    <div
      aria-label={`Step ${currentStep} of ${totalSteps}${label ? `: ${label}` : ''}`}
      aria-valuemax={totalSteps}
      aria-valuemin={1}
      aria-valuenow={currentStep}
      className={cn('flex items-center gap-1.5', className)}
      data-slot="onboarding-step-indicator"
      role="progressbar"
      {...props}
    >
      {Array.from({ length: totalSteps }, (_, i) => {
        const n = i + 1;
        const state = n === currentStep ? 'active' : n < currentStep ? 'completed' : 'inactive';
        return (
          <span
            aria-current={state === 'active' ? 'step' : undefined}
            className={cn(
              'h-1 max-w-10 flex-1 rounded-full transition-colors motion-reduce:transition-none',
              state === 'active' && 'bg-honey',
              state === 'completed' && 'bg-honey/50',
              state === 'inactive' && 'bg-line',
            )}
            data-state={state}
            key={n}
          />
        );
      })}
    </div>
  );
}

// ---- context -----------------------------------------------------------------------------------

export interface OnboardingContextValue {
  currentStep: number;
  totalSteps: number;
  setStep: (step: number) => void;
  canGoNext: boolean;
  canGoBack: boolean;
  handleBack: () => void;
  handleNext: () => void;
  handleComplete: () => void;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error('Onboarding components must be used within <Onboarding>');
  return ctx;
}

// ---- root --------------------------------------------------------------------------------------

export interface OnboardingRootProps extends PropsWithChildren, Omit<React.ComponentPropsWithoutRef<'div'>, 'children'> {
  /** Controlled step (1-based). */
  value?: number;
  defaultValue?: number;
  onValueChange?: (step: number) => void;
  totalSteps: number;
  onComplete?: () => void;
  /** Whether Next is allowed on this step. Default: always. */
  canGoNext?: (step: number) => boolean;
}

function OnboardingRoot({
  value,
  defaultValue = 1,
  onValueChange,
  totalSteps,
  onComplete,
  canGoNext: canGoNextFn,
  children,
  className,
  ...props
}: OnboardingRootProps) {
  const [currentStep, setCurrentStep] = useControllableState<number>({
    prop: value,
    defaultProp: defaultValue,
    ...(onValueChange ? { onChange: onValueChange } : {}),
  });

  const canGoNext = canGoNextFn ? canGoNextFn(currentStep) : true;
  const canGoBack = currentStep > 1;
  const handleNext = useCallback(() => setCurrentStep((s) => Math.min(totalSteps, s + 1)), [setCurrentStep, totalSteps]);
  const handleBack = useCallback(() => setCurrentStep((s) => Math.max(1, s - 1)), [setCurrentStep]);
  const handleComplete = useCallback(() => onComplete?.(), [onComplete]);
  const setStep = useCallback((s: number) => setCurrentStep(Math.min(totalSteps, Math.max(1, s))), [setCurrentStep, totalSteps]);

  const ctx = useMemo<OnboardingContextValue>(
    () => ({ currentStep, totalSteps, setStep, canGoNext, canGoBack, handleBack, handleNext, handleComplete }),
    [currentStep, totalSteps, setStep, canGoNext, canGoBack, handleBack, handleNext, handleComplete],
  );

  return (
    <OnboardingContext.Provider value={ctx}>
      <div className={cn('flex flex-col', className)} data-slot="onboarding" data-state={`step-${currentStep}`} {...props}>
        {children}
      </div>
    </OnboardingContext.Provider>
  );
}

// ---- step --------------------------------------------------------------------------------------

export interface OnboardingStepProps extends React.ComponentPropsWithoutRef<'section'> {
  step: number;
  /**
   * Enter anywhere in the step moves on (keyboard-only completion). Textareas keep Enter for
   * new lines unless they handle it themselves; buttons and links keep their own Enter.
   */
  onEnter?: () => void;
}

function OnboardingStep({ step, onEnter, children, className, onKeyDown, ...props }: OnboardingStepProps) {
  const { currentStep } = useOnboarding();
  if (currentStep !== step) return null;
  const keyDown = (e: KeyboardEvent<HTMLElement>): void => {
    onKeyDown?.(e);
    if (e.defaultPrevented || e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || !onEnter) return;
    const t = e.target as HTMLElement;
    if (t.closest('button, a, textarea, select, [role="radio"]') || (t instanceof HTMLInputElement && t.type === 'radio')) return;
    e.preventDefault();
    onEnter();
  };
  return (
    <section className={cn(className)} data-slot="onboarding-step" data-state="active" onKeyDown={keyDown} {...props}>
      {children}
    </section>
  );
}

function OnboardingStepIndicator(props: Omit<StepIndicatorProps, 'currentStep' | 'totalSteps'>) {
  const { currentStep, totalSteps } = useOnboarding();
  return <StepIndicator currentStep={currentStep} totalSteps={totalSteps} {...props} />;
}

// ---- header ------------------------------------------------------------------------------------

export interface OnboardingHeaderProps extends Omit<React.ComponentPropsWithoutRef<'div'>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  /** id for the title, so the step section can be labelled by it. */
  titleId?: string;
}

function OnboardingHeader({ title, description, titleId, className, ...props }: OnboardingHeaderProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)} data-slot="onboarding-header" {...props}>
      <h2 className="m-0 font-display text-2xl font-semibold text-text" data-slot="onboarding-title" id={titleId}>
        {title}
      </h2>
      {description ? (
        <p className="m-0 max-w-[560px] text-[15px] text-muted" data-slot="onboarding-description">
          {description}
        </p>
      ) : null}
    </div>
  );
}

// ---- navigation --------------------------------------------------------------------------------

export interface OnboardingNavigationProps extends React.ComponentPropsWithoutRef<'div'> {
  backLabel?: string;
  nextLabel?: string;
  completeLabel?: string;
  /** Shows "Skip for now" (every step but the first, 08-D2). Skipping goes to the next step. */
  onSkip?: () => void;
  skipLabel?: string;
  /** Runs instead of the plain step change, e.g. to save first. */
  onNext?: () => void;
  /** Disables the buttons and shows a progress label while a step saves. */
  busy?: boolean;
  busyLabel?: string;
  /** Override for Next (default: Root's canGoNext). */
  canGoNext?: boolean;
}

function OnboardingNavigation({
  backLabel = 'Back',
  nextLabel = 'Next',
  completeLabel = 'Finish setup',
  onSkip,
  skipLabel = 'Skip for now',
  onNext,
  busy = false,
  busyLabel = 'Saving…',
  canGoNext: override,
  className,
  ...props
}: OnboardingNavigationProps) {
  const { currentStep, totalSteps, canGoNext: ctxCanGoNext, canGoBack, handleBack, handleNext, handleComplete } = useOnboarding();
  const canGoNext = (override ?? ctxCanGoNext) && !busy;
  const isLast = currentStep === totalSteps;
  return (
    <div className={cn('flex flex-wrap items-center gap-2.5', className)} data-slot="onboarding-navigation" role="group" aria-label="Setup steps" {...props}>
      <Button disabled={!canGoBack || busy} onClick={handleBack} variant="outline">
        {backLabel}
      </Button>
      <span className="flex-1" />
      {onSkip && !isLast ? (
        <Button disabled={busy} onClick={onSkip} variant="ghost">
          {skipLabel}
        </Button>
      ) : null}
      <Button
        aria-busy={busy || undefined}
        data-slot={isLast ? 'onboarding-complete' : 'onboarding-next'}
        disabled={!canGoNext}
        onClick={onNext ?? (isLast ? handleComplete : handleNext)}
        size="lg"
      >
        {busy ? busyLabel : isLast ? completeLabel : nextLabel}
      </Button>
    </div>
  );
}

// ---- choice group ------------------------------------------------------------------------------

interface ChoiceGroupContextValue {
  value: string | null;
  setValue: (value: string) => void;
  name: string;
}

const ChoiceGroupContext = createContext<ChoiceGroupContextValue | null>(null);

function useChoiceGroup(): ChoiceGroupContextValue {
  const ctx = useContext(ChoiceGroupContext);
  if (!ctx) throw new Error('ChoiceGroup.Item must be used within ChoiceGroup');
  return ctx;
}

export interface ChoiceGroupProps extends Omit<React.ComponentPropsWithoutRef<'div'>, 'defaultValue'> {
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string) => void;
  /** Radio group name; also its accessible label unless aria-label is given. */
  name: string;
}

function ChoiceGroupRoot({ value, defaultValue = null, onValueChange, name, children, className, ...props }: ChoiceGroupProps) {
  const [current, setCurrent] = useControllableState<string | null>({
    prop: value === undefined ? undefined : value,
    defaultProp: defaultValue,
    onChange: (v) => {
      if (v !== null) onValueChange?.(v);
    },
  });
  const setValue = useCallback((v: string) => setCurrent(v), [setCurrent]);
  const ctx = useMemo(() => ({ value: current, setValue, name }), [current, setValue, name]);
  return (
    <ChoiceGroupContext.Provider value={ctx}>
      <div aria-label={name} className={cn(className)} data-slot="choice-group" role="radiogroup" {...props}>
        {children}
      </div>
    </ChoiceGroupContext.Provider>
  );
}

export interface ChoiceGroupItemProps extends React.ComponentPropsWithoutRef<'label'> {
  value: string;
  /** Accessible name of the radio input (the visible card text describes it). */
  inputLabel?: string;
}

function ChoiceGroupItem({ value: itemValue, inputLabel, children, className, ...props }: ChoiceGroupItemProps) {
  const { value, setValue, name } = useChoiceGroup();
  const selected = value === itemValue;
  return (
    <label
      className={cn(
        'cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-honey has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-ground',
        className,
      )}
      data-slot="choice-group-item"
      data-state={selected ? 'selected' : 'unselected'}
      {...props}
    >
      <input
        aria-label={inputLabel}
        checked={selected}
        className="sr-only"
        name={name}
        onChange={(e) => {
          if (e.currentTarget.checked) setValue(itemValue);
        }}
        type="radio"
        value={itemValue}
      />
      {children}
    </label>
  );
}

export const ChoiceGroup = Object.assign(ChoiceGroupRoot, { Item: ChoiceGroupItem });

export const Onboarding = Object.assign(OnboardingRoot, {
  Step: OnboardingStep,
  StepIndicator: OnboardingStepIndicator,
  Header: OnboardingHeader,
  Navigation: OnboardingNavigation,
});
