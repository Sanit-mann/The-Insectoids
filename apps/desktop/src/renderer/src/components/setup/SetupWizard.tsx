import type { SetupState } from '@insectoids/shared';
import { Check, FolderOpen, HardDrive, KeyRound, Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BrandMark } from '@/components/BrandMark';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { useProjectPicker } from '@/components/queen/useProjectPicker';
import { AboutYou } from '@/components/setup/AboutYou';
import { EngineCheck } from '@/components/setup/EngineCheck';
import { BrainFolder, Checklist, PresetCards } from '@/components/setup/parts';
import { Button } from '@/components/ui/button';
import { Onboarding, useOnboarding } from '@/components/ui/onboarding';
import { useHive } from '@/lib/hive-store';
import { setupActions } from '@/lib/setup-store';

/** Quick setup (08-D2). Every step but Welcome can be skipped; skipped items stay on the checklist. */
const STEPS = ['Welcome', 'Brain folder', 'AI engine', 'About you', 'Safety', 'First project', 'Done'] as const;
const titleId = (n: number): string => `setup-step-${n}-title`;

/**
 * First-run setup wizard (Onboarding 08), built on Cult UI `onboarding` (components/ui/onboarding.tsx).
 * Full window and calm: one step at a time, a step indicator, Back / Skip / Next, Enter = Next.
 */
export function SetupWizard({ state }: { state: SetupState }) {
  const [step, setStep] = useState(1);

  // Move focus to the new step's title so screen readers and keyboard users start at the top.
  useEffect(() => {
    document.getElementById(titleId(step))?.focus();
  }, [step]);

  return (
    <div className="flex min-h-full w-full justify-center overflow-y-auto bg-ground px-4 py-8 sm:px-6">
      <Onboarding
        aria-label="Set up The Insectoids"
        className="w-full max-w-[760px] gap-6"
        onValueChange={setStep}
        totalSteps={STEPS.length}
        value={step}
      >
        <header className="flex flex-wrap items-center gap-3">
          <BrandMark />
          <span className="font-display text-[17px] font-bold text-honey-text">The Insectoids</span>
          <span className="text-sm text-muted">· Setup</span>
          <div className="ml-auto flex min-w-[220px] flex-1 flex-col items-end gap-1.5 sm:flex-none">
            <span className="text-xs text-muted" data-testid="setup-step-label">
              Step {step} of {STEPS.length} · {STEPS[step - 1]}
            </span>
            <Onboarding.StepIndicator className="w-full sm:w-[260px]" labels={STEPS} />
          </div>
        </header>

        <div className="flex flex-col gap-6 rounded-3xl border border-line bg-surface/60 p-5 sm:p-8">
          <WelcomeStep />
          <BrainStep state={state} />
          <EngineStep />
          <AboutStep state={state} />
          <PresetStep state={state} />
          <ProjectStep />
          <DoneStep state={state} />
        </div>
      </Onboarding>
    </div>
  );
}

function StepTitle({ n, title, description }: { n: number; title: string; description?: string }) {
  return (
    <Onboarding.Header
      description={description}
      title={
        <span className="outline-none" id={titleId(n)} tabIndex={-1}>
          {title}
        </span>
      }
    />
  );
}

function WelcomeStep() {
  const { handleNext } = useOnboarding();
  return (
    <Onboarding.Step aria-labelledby={titleId(1)} className="flex flex-col gap-6" onEnter={handleNext} step={1}>
      <div className="flex flex-col items-start gap-4">
        <BrandMark size={64} />
        <StepTitle
          description="A hive of AI insects that works on your projects: you give the Queen a goal, she plans it, insects do the work in safe copies of your files, and nothing reaches your project without your approval."
          n={1}
          title="Welcome to The Insectoids"
        />
      </div>
      <ul aria-label="Privacy promise" className="m-0 grid list-none gap-2.5 p-0">
        {[
          { icon: HardDrive, text: 'Your Brain stays on this PC.' },
          { icon: Lock, text: 'Nothing is uploaded. No account with us.' },
          { icon: KeyRound, text: 'Agents never see your keys or logins.' },
        ].map(({ icon: Icon, text }) => (
          <li className="flex min-h-11 items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-2.5 text-[15px] text-text" key={text}>
            <Icon aria-hidden="true" className="size-5 shrink-0 text-honey-text" />
            {text}
          </li>
        ))}
      </ul>
      <p className="m-0 text-sm text-muted">Quick setup takes about five minutes. You can skip any step and finish it later in Settings.</p>
      <Onboarding.Navigation nextLabel="Get started" />
    </Onboarding.Step>
  );
}

function BrainStep({ state }: { state: SetupState }) {
  const { handleNext } = useOnboarding();
  return (
    <Onboarding.Step aria-labelledby={titleId(2)} className="flex flex-col gap-5" onEnter={handleNext} step={2}>
      <StepTitle
        description="The Brain is the hive's shared memory: decisions, tasks, facts and outcomes. It's a folder on this PC; the default is fine for most people."
        n={2}
        title="Where should your Brain live?"
      />
      <BrainFolder state={state} />
      <Onboarding.Navigation nextLabel="Use this folder" onSkip={handleNext} />
    </Onboarding.Step>
  );
}

function EngineStep() {
  const { handleNext } = useOnboarding();
  return (
    <Onboarding.Step aria-labelledby={titleId(3)} className="flex flex-col gap-5" onEnter={handleNext} step={3}>
      <StepTitle
        description="The insects think with an AI engine you sign in to yourself. Phase 1 uses Claude Code with your own Claude subscription."
        n={3}
        title="Connect an AI engine"
      />
      <EngineCheck />
      <Onboarding.Navigation onSkip={handleNext} />
    </Onboarding.Step>
  );
}

function AboutStep({ state }: { state: SetupState }) {
  const { handleNext } = useOnboarding();
  return (
    <Onboarding.Step aria-labelledby={titleId(4)} className="flex flex-col gap-5" step={4}>
      <StepTitle
        description="A few quick questions from the Queen so the hive works the way you do. Skip any you like."
        n={4}
        title="About you"
      />
      <AboutYou answered={state.aboutAnswered} onDone={handleNext} />
      <Onboarding.Navigation onSkip={handleNext} />
    </Onboarding.Step>
  );
}

function PresetStep({ state }: { state: SetupState }) {
  const { handleNext } = useOnboarding();
  return (
    <Onboarding.Step aria-labelledby={titleId(5)} className="flex flex-col gap-5" onEnter={handleNext} step={5}>
      <StepTitle
        description="How much the hive may do on its own. You can change this any time in Settings."
        n={5}
        title="Choose a safety preset"
      />
      <PresetCards value={state.preset} />
      <Onboarding.Navigation onSkip={handleNext} />
    </Onboarding.Step>
  );
}

function ProjectStep() {
  const { handleNext } = useOnboarding();
  const { snapshot } = useHive();
  const { pick, picking, error, clearError } = useProjectPicker();
  const project = snapshot?.project ?? null;
  return (
    <Onboarding.Step aria-labelledby={titleId(6)} className="flex flex-col gap-5" onEnter={handleNext} step={6}>
      <StepTitle
        description="Pick a project folder (a git repository) for the hive to work on. Insects only ever work in separate copies of it."
        n={6}
        title="Your first project (optional)"
      />
      {project ? (
        <div className="flex flex-col gap-1 rounded-2xl border border-line bg-surface p-4" data-testid="setup-project">
          <span className="flex items-center gap-2 font-semibold text-text">
            <Check aria-hidden="true" className="size-4 text-st-done" />
            {project.name}
          </span>
          <code className="break-all font-mono text-[13px] text-muted">{project.path}</code>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2.5">
        <Button disabled={picking} onClick={() => void pick()} variant="outline">
          <FolderOpen aria-hidden="true" />
          {picking ? 'Choosing…' : project ? 'Choose a different folder…' : 'Choose project folder…'}
        </Button>
      </div>
      {error ? <InlineAlert message={error} onDismiss={clearError} title="Could not use that folder" tone="error" /> : null}
      <Onboarding.Navigation onSkip={handleNext} skipLabel="Later" />
    </Onboarding.Step>
  );
}

function DoneStep({ state }: { state: SetupState }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finish = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const r = await setupActions.finish();
    setBusy(false);
    if (!r.ok) setError(r.error);
  };
  const open = state.checklist.filter((i) => !i.done && i.phase === 1).length;
  return (
    <Onboarding.Step aria-labelledby={titleId(7)} className="flex flex-col gap-5" onEnter={() => void finish()} step={7}>
      <StepTitle
        description={
          open
            ? `${open} item${open === 1 ? '' : 's'} left to finish. They stay on the checklist in Settings; finish them whenever you like.`
            : 'Everything for Phase 1 is set. Give the Queen her first goal.'
        }
        n={7}
        title="You're ready"
      />
      <Checklist items={state.checklist} />
      {error ? <InlineAlert message={error} onDismiss={() => setError(null)} title="Could not finish setup" tone="error" /> : null}
      <Onboarding.Navigation busy={busy} busyLabel="Finishing…" completeLabel="Open the hive" onNext={() => void finish()} />
    </Onboarding.Step>
  );
}
