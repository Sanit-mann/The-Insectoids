import { Palette, RotateCcw } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { MeaningSearchSettings } from '@/components/brain/MeaningSearch';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { BrainFolder, Checklist, PresetCards } from '@/components/setup/parts';
import { Button } from '@/components/ui/button';
import { loadSetup, refreshSetup, setupActions, useSetup } from '@/lib/setup-store';

function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="m-0 font-display text-lg font-semibold text-text" id={id}>
          {title}
        </h2>
        {description ? <p className="m-0 text-sm text-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Settings, Phase 1 minimal (App 07): the "finish setup" checklist with "Run setup again" (08-D1),
 * the safety preset (08-D7) and the Brain folder (01-D4). Theme stays in the top bar.
 */
export function SettingsScreen() {
  const { state, loading, loadError } = useSetup();
  const [restarting, setRestarting] = useState(false);
  // Checklist items get done elsewhere too (engines, providers, the sample goal): read them fresh on open.
  useEffect(() => {
    void refreshSetup();
  }, []);
  const [error, setError] = useState<string | null>(null);

  const rerun = async (): Promise<void> => {
    setRestarting(true);
    setError(null);
    const r = await setupActions.restart();
    setRestarting(false);
    if (!r.ok) setError(r.error);
  };

  if (!state) {
    return (
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4 p-6">
        {loadError ? (
          <InlineAlert actions={[{ label: 'Try again', onClick: () => void loadSetup(), primary: true }]} message={loadError} title="Could not load settings" tone="error" />
        ) : loading ? (
          <div aria-busy="true" aria-label="Loading settings" className="flex flex-col gap-3" role="status">
            <div className="h-6 w-48 rounded bg-surface-2 motion-safe:animate-pulse" />
            <div className="h-24 w-full rounded-2xl bg-surface-2 motion-safe:animate-pulse" />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-8 p-6">
      <Section
        description="What's done and what's left from setup. Items for later phases come alive as the app grows."
        id="settings-setup"
        title="Setup"
      >
        <Checklist items={state.checklist} />
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={restarting} onClick={() => void rerun()} variant="outline">
            <RotateCcw aria-hidden="true" />
            {restarting ? 'Opening setup…' : 'Run setup again'}
          </Button>
          <span className="text-sm text-muted">Your Brain, project and answers are kept.</span>
        </div>
        {error ? <InlineAlert message={error} onDismiss={() => setError(null)} title="Could not open setup" tone="error" /> : null}
      </Section>

      <Section description="How much the hive may do on its own. It applies to new goals." id="settings-preset" title="Safety preset">
        <PresetCards compact value={state.preset} />
      </Section>

      <Section
        description="Where the hive's shared memory lives on this PC. It can't be moved while a goal is running."
        id="settings-brain"
        title="Brain folder"
      >
        <BrainFolder showNote={false} state={state} />
      </Section>

      <Section
        description="Lets the Brain find notes by meaning, not just by the same words. A small model runs on this PC; nothing about your Brain leaves it."
        id="settings-meaning"
        title="Meaning search"
      >
        <MeaningSearchSettings />
      </Section>

      <Section id="settings-theme" title="Theme">
        <p className="m-0 flex items-center gap-2 text-sm text-muted">
          <Palette aria-hidden="true" className="size-4" />
          Switch between dark and light with the sun/moon button in the top bar.
        </p>
      </Section>
    </div>
  );
}
