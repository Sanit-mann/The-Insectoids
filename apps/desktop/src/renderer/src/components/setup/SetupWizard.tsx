import type { SetupState } from '@insectoids/shared';
import { Check, CircleCheck, CircleDashed, FolderOpen, HardDrive, KeyRound, Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EnginesPanel } from '@/components/connections/EnginesPanel';
import { ProvidersTab } from '@/components/connections/ProvidersTab';
import { VaultTab } from '@/components/connections/VaultTab';
import { BrandMark } from '@/components/BrandMark';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { useProjectPicker } from '@/components/queen/useProjectPicker';
import { AboutYou } from '@/components/setup/AboutYou';
import { BrainFolder, CURRENT_PHASE, Checklist, PresetCards } from '@/components/setup/parts';
import { SampleGoal } from '@/components/setup/SampleGoal';
import { Button } from '@/components/ui/button';
import { Onboarding, useOnboarding } from '@/components/ui/onboarding';
import { useHive } from '@/lib/hive-store';
import { refreshSetup, setupActions } from '@/lib/setup-store';

/**
 * Setup in the order of the Onboarding flow table (08; Phase 2 C5): the quick essentials, the optional
 * providers and the optional sample goal. Every step but Welcome can be skipped; skipped items stay on the checklist.
 */
const STEPS = ['Welcome', 'Brain folder', 'AI engines', 'Providers', 'About you', 'First project', 'Safety', 'First goal', 'Done'] as const;
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
    // Engines, providers and the sample change outside this wizard's actions: read the checklist fresh.
    void refreshSetup();
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
          <EngineStep state={state} />
          <ProvidersStep onOpenEngines={() => setStep(3)} />
          <AboutStep state={state} />
          <ProjectStep />
          <PresetStep state={state} />
          <FirstGoalStep state={state} />
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


/** Engine ids that can work right now: the setup state's list plus the live hive snapshot (whichever is fresher). */
function useReadyEngines(state: SetupState): string[] {
  const { snapshot } = useHive();
  const live = (snapshot?.engines ?? []).filter((e) => e.enabled && (e.state === 'ready' || e.state === 'fake')).map((e) => e.id);
  return [...new Set([...state.readyEngines, ...live])];
}

function EngineStep({ state }: { state: SetupState }) {
  const { handleNext } = useOnboarding();
  const { snapshot } = useHive();
  const ready = useReadyEngines(state);
  const names = ready.map((id) => snapshot?.engines.find((e) => e.id === id)?.name ?? id);
  return (
    <Onboarding.Step aria-labelledby={titleId(3)} className="flex flex-col gap-5" {...(ready.length ? { onEnter: handleNext } : {})} step={3}>
      <StepTitle
        description="The insects think with AI engines you sign in to yourself, on your own subscriptions. You need at least one that works; more lets the Treasurer pick the cheapest one that can do each card."
        n={3}
        title="Connect your AI engines"
      />
      <div
        className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-4"
        data-ready={ready.length}
        data-testid="setup-engines-summary"
        role="status"
      >
        {ready.length ? (
          <CircleCheck aria-hidden="true" className="size-6 shrink-0 text-st-done" />
        ) : (
          <CircleDashed aria-hidden="true" className="size-6 shrink-0 text-st-blocked" />
        )}
        <span className="text-sm text-text">
          {ready.length
            ? `${ready.length} engine${ready.length === 1 ? '' : 's'} ready: ${names.join(', ')}.`
            : 'No engine is ready yet. The hive needs at least one to work.'}
        </span>
      </div>
      <EnginesPanel
        intro="Each engine signs in with its own login; the hive never sees your passwords or login tokens. Install opens a dialog with the exact command, and nothing runs until you say yes."
        noneReady={
          <InlineAlert
            message="The cheapest way to start is a free local model: install Ollama from ollama.com and OpenCode above, then add Ollama on the next step (Providers). Some engines also have a free tier. Or skip for now and connect one later in Connections."
            title="No engine is ready"
            tone="waiting"
          />
        }
      />
      <Onboarding.Navigation canGoNext={ready.length > 0} onSkip={handleNext} />
    </Onboarding.Step>
  );
}

function ProvidersStep({ onOpenEngines }: { onOpenEngines: () => void }) {
  const { handleNext } = useOnboarding();
  const [vault, setVault] = useState(false);
  const openVault = (): void => {
    setVault(true);
    requestAnimationFrame(() => document.getElementById('setup-vault-title')?.focus());
  };
  return (
    <Onboarding.Step aria-labelledby={titleId(4)} className="flex flex-col gap-5" step={4}>
      <StepTitle
        description="Optional. Add an API provider (OpenRouter, FreeLLMAPI, a local Ollama or LM Studio, or your own Anthropic or OpenAI API key). Keys go into the Vault, encrypted on this PC; agents never see them."
        n={4}
        title="API providers (optional)"
      />
      <div className="flex flex-col gap-4" data-testid="setup-providers">
        <ProvidersTab onOpenEngines={onOpenEngines} onOpenVault={openVault} />
      </div>
      {vault ? (
        <section aria-labelledby="setup-vault-title" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4" data-testid="setup-vault">
          <h3 className="m-0 font-display text-base font-semibold text-text outline-none" id="setup-vault-title" tabIndex={-1}>
            Add a key to the Vault
          </h3>
          <VaultTab />
        </section>
      ) : (
        <p className="m-0 text-sm text-muted">
          A provider that needs a key uses one from the Vault.{' '}
          <Button className="h-auto min-h-0 p-0 text-sm" onClick={openVault} type="button" variant="link">
            Add a key to the Vault
          </Button>
        </p>
      )}
      <Onboarding.Navigation onSkip={handleNext} />
    </Onboarding.Step>
  );
}

function AboutStep({ state }: { state: SetupState }) {
  const { handleNext } = useOnboarding();
  return (
    <Onboarding.Step aria-labelledby={titleId(5)} className="flex flex-col gap-5" step={5}>
      <StepTitle
        description="A few quick questions from the Queen so the hive works the way you do. Skip any you like."
        n={5}
        title="About you"
      />
      <AboutYou answered={state.aboutAnswered} onDone={handleNext} />
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
        description="Pick a project folder (a git repository) for the hive to work on. Insects only ever work in separate copies of it, and its code is mapped right away with plain code, at no token cost."
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

function PresetStep({ state }: { state: SetupState }) {
  const { handleNext } = useOnboarding();
  return (
    <Onboarding.Step aria-labelledby={titleId(7)} className="flex flex-col gap-5" onEnter={handleNext} step={7}>
      <StepTitle
        description="How much the hive may do on its own. You can change this any time in Settings."
        n={7}
        title="Choose a safety preset"
      />
      <PresetCards value={state.preset} />
      <Onboarding.Navigation onSkip={handleNext} />
    </Onboarding.Step>
  );
}

function FirstGoalStep({ state }: { state: SetupState }) {
  const { handleNext } = useOnboarding();
  const [error, setError] = useState<string | null>(null);
  // "Watch it" finishes setup and opens that screen (App listens for insectoids:navigate even during setup).
  const watch = async (screen: 'hive' | 'taskboard'): Promise<void> => {
    setError(null);
    window.dispatchEvent(new CustomEvent('insectoids:navigate', { detail: screen }));
    const r = await setupActions.finish();
    if (!r.ok) setError(r.error);
  };
  return (
    <Onboarding.Step aria-labelledby={titleId(8)} className="flex flex-col gap-5" step={8}>
      <StepTitle
        description="Optional. Watch the hive plan, work, get checked and finish on a small practice project, before you give it real work. You see what it costs first."
        n={8}
        title="Try a sample goal"
      />
      <SampleGoal onWatch={(s) => void watch(s)} state={state} />
      {error ? <InlineAlert message={error} onDismiss={() => setError(null)} title="Could not finish setup" tone="error" /> : null}
      <Onboarding.Navigation {...(state.sample ? {} : { onSkip: handleNext })} skipLabel="Skip: I'll give the Queen my own goal" />
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
  const open = state.checklist.filter((i) => !i.done && i.phase <= CURRENT_PHASE).length;
  return (
    <Onboarding.Step aria-labelledby={titleId(9)} className="flex flex-col gap-5" onEnter={() => void finish()} step={9}>
      <StepTitle
        description={
          open
            ? `${open} item${open === 1 ? '' : 's'} left to finish. They stay on the checklist in Settings; finish them whenever you like.`
            : 'Everything is set. Give the Queen her first goal.'
        }
        n={9}
        title="You're ready"
      />
      <Checklist items={state.checklist} />
      {error ? <InlineAlert message={error} onDismiss={() => setError(null)} title="Could not finish setup" tone="error" /> : null}
      <Onboarding.Navigation busy={busy} busyLabel="Finishing…" completeLabel="Open the hive" onNext={() => void finish()} />
    </Onboarding.Step>
  );
}
