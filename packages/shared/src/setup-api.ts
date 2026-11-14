import { z } from 'zod';

/**
 * First-run setup (Onboarding 08), Phase 1 "quick setup" (08-D2):
 * welcome + privacy promise → Brain folder → engine (Claude Code detect + sign-in) →
 * short "about you" → safety preset → (optional) first project. Everything skipped goes on the
 * "finish setup" checklist in Settings, and setup can be rerun from there (08-D1).
 *
 * Owned by the main process: `<userData>/app.json`. The Brain folder decides where the Brain host
 * opens brain.db, so main restarts the host when it changes.
 */
export const SETUP_IPC = {
  state: 'setup:state',
  /** Folder picker for the Brain folder; returns the new state (unchanged if cancelled). */
  pickBrainFolder: 'setup:pick-brain-folder',
  /** Back to the default Brain folder. */
  useDefaultBrainFolder: 'setup:default-brain-folder',
  setPreset: 'setup:set-preset',
  saveAbout: 'setup:save-about',
  finish: 'setup:finish',
  /** Settings → "Run setup again". */
  restart: 'setup:restart',
  /** C5 (08-D8): the sample goal's cost estimate, shown before anything runs. */
  sampleEstimate: 'setup:sample-estimate',
  /** C5 (08-D8): creates (or reuses) the practice project and starts the sample goal on it, after the user said yes. */
  startSample: 'setup:start-sample',
  /** Phase 3 A2 (05-D5): keep the computer awake while the hive works (off by default; costs battery). */
  setKeepAwake: 'setup:set-keep-awake',
  /** Phase 3 B2 (05-D8): desktop notifications for approvals needed and failures (on by default). */
  setNotifications: 'setup:set-notifications',
  /** Phase 3 B2: start the app (hidden, in the tray) when the user signs in to the computer (off by default). */
  setStartWithComputer: 'setup:set-start-with-computer',
} as const;

/**
 * The optional sample goal (08-D8): a small goal on a practice project in its own folder under the app's data,
 * never the user's real files. The estimate comes first; nothing runs until the user starts it.
 */
export const SampleEstimateSchema = z.object({
  goalText: z.string(),
  /** Where it would run, e.g. "<userData>/practice-project". */
  practicePath: z.string(),
  /** The engine it would use (the hive's default), or null when none is ready. */
  engine: z.string().nullable(),
  tokensLow: z.number().int(),
  tokensHigh: z.number().int(),
  /** null when the engine is a subscription with no per-token price (then `note` says so). */
  costUsdLow: z.number().nullable(),
  costUsdHigh: z.number().nullable(),
  /** How it was estimated, in plain words (e.g. "from this hive's last 12 runs" or "a typical small goal"). */
  basis: z.string(),
  note: z.string(),
  /** false → `reason` says why (no engine ready, a goal already running…). */
  canRun: z.boolean(),
  reason: z.string().nullable(),
});
export type SampleEstimate = z.infer<typeof SampleEstimateSchema>;

export const StartSampleResultSchema = z.union([
  /** The practice project is now the open project and the goal was submitted with a budget cap of tokensHigh. */
  z.object({ ok: z.literal(true), goalId: z.string(), practicePath: z.string(), state: z.lazy(() => SetupStateSchema) }),
  z.object({ ok: z.literal(false), error: z.string(), state: z.lazy(() => SetupStateSchema) }),
]);
export type StartSampleResult = z.infer<typeof StartSampleResultSchema>;

/** Safety presets (08-D7). None of them can turn off the always-ask list or the command guard. */
export const PresetSchema = z.enum(['careful', 'balanced', 'hands-off']);
export type Preset = z.infer<typeof PresetSchema>;

export interface PresetSpec {
  label: string;
  /** One line, plain words. */
  summary: string;
  /** Most insects working at once (02-D7). */
  insectCap: number;
  /** Default token budget per goal. */
  goalBudgetTokens: number;
  /** true: every plan waits for approval; false: only big plans (more than one wave, 02-D11). */
  approveEveryPlan: boolean;
}

export const PRESETS: Record<Preset, PresetSpec> = {
  careful: {
    label: 'Careful',
    summary: 'You approve every plan. Two insects at a time, smaller budgets.',
    insectCap: 2,
    goalBudgetTokens: 1_000_000,
    approveEveryPlan: true,
  },
  balanced: {
    label: 'Balanced',
    summary: 'You approve big plans. Three insects at a time. Recommended.',
    insectCap: 3,
    goalBudgetTokens: 2_000_000,
    approveEveryPlan: false,
  },
  'hands-off': {
    label: 'Hands-off',
    summary: 'You approve big plans. Five insects at a time, larger budgets.',
    insectCap: 5,
    goalBudgetTokens: 4_000_000,
    approveEveryPlan: false,
  },
};

/** Always needs you, whatever the preset (02-D7, 06-D5). Shown on the preset step. */
export const ALWAYS_ASK = [
  'Merging into your branch',
  'Deleting outside the hive’s copies',
  'Pushing, publishing or deploying',
  'Spending beyond the budget',
] as const;

/** The short "about you" interview (08-D3, D4). Every question can be skipped. */
export const ABOUT_QUESTIONS = [
  { id: 'role', question: 'What do you do? Your role and the kind of work you want help with.' },
  { id: 'goals', question: 'What are you working towards right now? Your current goals or priorities.' },
  { id: 'updates', question: 'How do you like updates: short or detailed, and how often?' },
  { id: 'voice', question: 'Paste a few lines you wrote (an email or a post), so the hive can match your voice.' },
  { id: 'tools', question: 'Which tools do you already use? (e.g. GitHub, Notion, Figma, VS Code)' },
] as const;
export type AboutQuestionId = (typeof ABOUT_QUESTIONS)[number]['id'];
export const AboutQuestionIdSchema = z.enum(['role', 'goals', 'updates', 'voice', 'tools']);

/** Answers become confirmed facts on the Global shelf (the user said them), editable later. */
export const SaveAboutSchema = z.object({
  answers: z
    .array(z.object({ id: AboutQuestionIdSchema, answer: z.string().trim().min(1).max(4000) }))
    .max(5),
});
export type SaveAbout = z.infer<typeof SaveAboutSchema>;

export const ChecklistItemSchema = z.object({
  id: z.enum(['brain', 'engine', 'about', 'preset', 'project', 'backup', 'providers', 'sample-goal']),
  label: z.string(),
  done: z.boolean(),
  /** Phase in which this item can be completed in the app (later items are shown as "later"). */
  phase: z.number().int(),
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const SetupStateSchema = z.object({
  /** false → the app shows the setup wizard instead of the shell. */
  completed: z.boolean(),
  completedAt: z.number().nullable(),
  brainDir: z.string(),
  defaultBrainDir: z.string(),
  preset: PresetSchema,
  /** Ids of "about you" questions already answered (saved in the Brain). */
  aboutAnswered: z.array(AboutQuestionIdSchema),
  /** C5: engines that can work right now (ready), by id; setup needs at least one (08-D5). */
  readyEngines: z.array(z.string()).default([]),
  /** C5: API providers the user added (switched on). */
  providers: z.number().int().default(0),
  /** C5: the sample goal, once started (08-D8). */
  sample: z.object({ goalId: z.string(), practicePath: z.string(), startedAt: z.number() }).nullable().default(null),
  /** C5: the project that was open before the sample switched to the practice project ("back to your project"). */
  previousProject: z.string().nullable().default(null),
  /**
   * Phase 3 A2 (05-D5): `enabled` is the user's switch (off by default); `active` is true while it is on and the
   * hive is working, so the computer is being kept awake right now.
   */
  keepAwake: z.object({ enabled: z.boolean(), active: z.boolean() }).default({ enabled: false, active: false }),
  /** Desktop notifications (B2): on by default; only approvals needed and failures, only while the window isn't in front. */
  notifications: z.object({ enabled: z.boolean() }).default({ enabled: true }),
  /**
   * Start with my computer (B2): off by default. `available` is false where the app can't register itself (Linux for
   * now); `message` says the state in words ("Off: start The Insectoids yourself.", "On: it starts in the tray when you sign in.").
   */
  startWithComputer: z.object({ enabled: z.boolean(), available: z.boolean(), message: z.string() }).default({ enabled: false, available: false, message: '' }),
  checklist: z.array(ChecklistItemSchema),
});
export type SetupState = z.infer<typeof SetupStateSchema>;

/** Errors come back as messages; the UI shows them inline. */
export const SetupResultSchema = z.union([
  z.object({ ok: z.literal(true), state: SetupStateSchema }),
  z.object({ ok: z.literal(false), error: z.string(), state: SetupStateSchema }),
]);
export type SetupResult = z.infer<typeof SetupResultSchema>;

/** The setup part of `window.insectoids`. */
export interface SetupApi {
  state(): Promise<SetupState>;
  pickBrainFolder(): Promise<SetupResult>;
  useDefaultBrainFolder(): Promise<SetupResult>;
  setPreset(preset: Preset): Promise<SetupResult>;
  saveAbout(input: SaveAbout): Promise<SetupResult>;
  finish(): Promise<SetupResult>;
  restart(): Promise<SetupResult>;
  sampleEstimate(): Promise<SampleEstimate>;
  startSample(): Promise<StartSampleResult>;
  setKeepAwake(enabled: boolean): Promise<SetupResult>;
  setNotifications(enabled: boolean): Promise<SetupResult>;
  setStartWithComputer(enabled: boolean): Promise<SetupResult>;
}
