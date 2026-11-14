import { type BrowserWindow, type IpcMainInvokeEvent, dialog, ipcMain } from 'electron';
import type { BrainClient } from '@insectoids/brain-service';
import { join } from 'node:path';
import {
  type AboutQuestionId,
  BudgetsViewSchema,
  CommandResultSchema,
  HiveSnapshotSchema,
  type SampleEstimate,
  SampleEstimateSchema,
  type StartSampleResult,
  StartSampleResultSchema,
  PresetSchema,
  SETUP_IPC,
  SaveAboutSchema,
  type SetupResult,
  SetupResultSchema,
  type SetupState,
  SetupStateSchema,
} from '@insectoids/shared';
import { type AppSettingsStore, limitsFor, notificationsOn } from './app-settings';
import type { BrainHost } from './brain-host';
import type { LoginItem } from './login-item';
import { type Git, PRACTICE_DIR_NAME, PracticeProjectError, SAMPLE_GOAL_TEXT, ensurePracticeProject } from './practice-project';
import { ABOUT_SOURCE, aboutTitle, buildChecklist, findAboutRecords, readyEngineIds } from './setup-model';
import { type PastRun, estimateSample } from './setup-sample';

export interface SetupDeps {
  settings: AppSettingsStore;
  host: () => BrainHost | null;
  /** The app's data folder: the practice project lives in `<userData>/practice-project` (C5). */
  userDataDir: string;
  /** Switched-on API providers (C5). */
  providers: () => number;
  /** e2e: the scripted test engine counts as a working engine. */
  countScriptedEngine: boolean;
  /** Tests: replace git for the practice project. */
  git?: Git;
  window: () => BrowserWindow | null;
  /** Whether the computer is being kept awake right now (A2), and a hook to apply a changed switch. */
  keepAwake: { active: () => boolean; changed: () => Promise<void> };
  /** "Start with my computer" (B2): the login item (a fake under e2e). */
  loginItem: LoginItem;
  /** Notifications or the login item changed (B2): the tray's checkbox follows. */
  backgroundChanged: () => void;
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
  /** Move the Brain to another folder (null = default). Resolves to an error in plain words, or null. */
  switchBrainDir: (dir: string | null) => Promise<string | null>;
  /** e2e only (INSECTOIDS_E2E): the folder the native picker would return, so the real switch can be tested. */
  testPickedFolder?: string;
}

/** First-run setup over IPC (Onboarding 08, Phase 1 Step 9). Every reply carries the fresh state. */
export function registerSetupIpc(d: SetupDeps): void {
  const client = (): BrainClient | null => {
    const h = d.host();
    return h && h.status.state === 'ready' ? h.client : null;
  };

  const state = async (): Promise<SetupState> => {
    const s = d.settings.value;
    const h = d.host();
    const snap = h && h.status.state === 'ready' ? await h.call('snapshot').then((x) => HiveSnapshotSchema.parse(x), () => null) : null;
    const c = client();
    const about = c ? await findAboutRecords(c).catch(() => new Map<AboutQuestionId, string>()) : new Map<AboutQuestionId, string>();
    const completed = s.onboarding.completedAt !== undefined;
    const readyEngines = snap ? readyEngineIds(snap.engines, d.countScriptedEngine) : [];
    const providers = d.providers();
    return SetupStateSchema.parse({
      completed,
      completedAt: s.onboarding.completedAt ?? null,
      brainDir: d.settings.brainDir,
      defaultBrainDir: d.settings.defaultBrainDir,
      preset: s.preset,
      aboutAnswered: [...about.keys()],
      readyEngines,
      providers,
      sample: s.sample ?? null,
      previousProject: s.previousProject ?? null,
      keepAwake: { enabled: s.keepAwake === true, active: d.keepAwake.active() },
      notifications: { enabled: notificationsOn(s) },
      startWithComputer: d.loginItem.state(),
      checklist: buildChecklist({
        completed,
        engineReady: readyEngines.length > 0,
        aboutAnswered: about.size,
        hasProject: Boolean(snap?.project),
        providers,
        sampleStarted: Boolean(s.sample),
      }),
    });
  };

  const practicePath = join(d.userDataDir, PRACTICE_DIR_NAME);

  /** The hive's snapshot, or null while the Brain host is not ready. */
  const snapshot = async () => {
    const h = d.host();
    if (!h || h.status.state !== 'ready') return null;
    return h.call('snapshot').then((x) => HiveSnapshotSchema.parse(x), () => null);
  };

  const estimate = async (): Promise<SampleEstimate> => {
    const h = d.host();
    const snap = await snapshot();
    const budgets = h && snap ? await h.call('budgets').then((x) => BudgetsViewSchema.parse(x), () => null) : null;
    const runs: PastRun[] = (budgets?.routing ?? []).map((r) => ({ role: r.role, engine: r.engine, tokens: r.tokens, costUsd: r.costUsd }));
    // The hive's default engine (snapshot.engine names it; the card has its id), only when it can run.
    const engine =
      snap && (snap.engine.state === 'ready' || snap.engine.state === 'fake') ? (snap.engines.find((e) => e.name === snap.engine.name) ?? null) : null;
    const busy = (snap?.goals ?? []).some((g) => g.status === 'planning' || g.status === 'awaiting_approval' || g.status === 'running');
    return SampleEstimateSchema.parse(estimateSample({ runs, engine: engine ? { id: engine.id, name: engine.name, state: engine.state } : null, busy, practicePath }));
  };

  const result = async (error?: string | null): Promise<SetupResult> =>
    SetupResultSchema.parse(error ? { ok: false, error, state: await state() } : { ok: true, state: await state() });

  const handle = (channel: string, fn: (arg: unknown) => Promise<unknown>): void => {
    ipcMain.handle(channel, async (event, arg: unknown) => {
      d.assertTrustedSender(event);
      return fn(arg);
    });
  };

  handle(SETUP_IPC.state, () => state());

  handle(SETUP_IPC.pickBrainFolder, async () => {
    const win = d.window();
    const options = {
      title: 'Choose where the Brain lives',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory' as const, 'createDirectory' as const],
    };
    if (d.testPickedFolder) return result(await d.switchBrainDir(d.testPickedFolder));
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const dir = res.filePaths[0];
    if (res.canceled || !dir) return result();
    return result(await d.switchBrainDir(dir));
  });

  handle(SETUP_IPC.useDefaultBrainFolder, async () => result(await d.switchBrainDir(null)));

  handle(SETUP_IPC.setPreset, async (arg) => {
    const preset = PresetSchema.parse(arg);
    d.settings.update((s) => ({ ...s, preset }));
    const h = d.host();
    // The host also gets the preset at every start, so a host that is down now catches up later.
    if (h && h.status.state === 'ready') {
      const err = await h.call('setLimits', limitsFor(preset)).then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
      if (err) return result(`Saved, but the hive could not apply it yet: ${err}`);
    }
    return result();
  });

  handle(SETUP_IPC.setKeepAwake, async (arg) => {
    if (typeof arg !== 'boolean') throw new Error('Keep awake is on or off.');
    const enabled = arg;
    d.settings.update((s) => {
      const next = { ...s };
      if (enabled) next.keepAwake = true;
      else delete next.keepAwake;
      return next;
    });
    await d.keepAwake.changed();
    return result();
  });

  handle(SETUP_IPC.setNotifications, async (arg) => {
    if (typeof arg !== 'boolean') throw new Error('Notifications are on or off.');
    const enabled = arg;
    d.settings.update((s) => {
      const next = { ...s };
      if (enabled) delete next.notifications;
      else next.notifications = false;
      return next;
    });
    d.backgroundChanged();
    return result();
  });

  handle(SETUP_IPC.setStartWithComputer, async (arg) => {
    if (typeof arg !== 'boolean') throw new Error('Start with my computer is on or off.');
    const err = d.loginItem.set(arg);
    d.backgroundChanged();
    return result(err);
  });

  handle(SETUP_IPC.saveAbout, async (arg) => {
    const input = SaveAboutSchema.parse(arg);
    const c = client();
    if (!c) return result(d.host()?.status.message ?? 'The Brain is not running.');
    try {
      const existing = await findAboutRecords(c);
      // The user said these, so they are confirmed facts on the Global shelf (08-D4), editable later.
      for (const { id, answer } of input.answers) {
        const recId = existing.get(id);
        if (recId) {
          const rec = await c.get(recId);
          if (rec && rec.body !== answer) await c.update({ id: recId, body: answer });
        } else {
          await c.write({ kind: 'fact', shelf: 'global', title: aboutTitle(id), body: answer, source: ABOUT_SOURCE, trust: 'confirmed' });
        }
      }
      return result();
    } catch (err) {
      return result(err instanceof Error ? err.message : String(err));
    }
  });

  handle(SETUP_IPC.finish, async () => {
    d.settings.update((s) => ({ ...s, onboarding: { completedAt: Date.now() } }));
    return result();
  });

  handle(SETUP_IPC.restart, async () => {
    d.settings.update((s) => ({ ...s, onboarding: {} }));
    return result();
  });

  // The optional sample goal (08-D8; C5): the estimate first, and nothing runs until the user starts it.
  handle(SETUP_IPC.sampleEstimate, () => estimate());

  handle(SETUP_IPC.startSample, async () => {
    const fail = async (error: string): Promise<StartSampleResult> => StartSampleResultSchema.parse({ ok: false, error, state: await state() });
    const h = d.host();
    if (!h || h.status.state !== 'ready') return fail(h?.status.message ?? 'The Brain is not running.');
    const est = await estimate();
    if (!est.canRun) return fail(est.reason ?? 'The sample goal cannot run right now.');
    let path: string;
    try {
      path = (await ensurePracticeProject(practicePath, d.git)).path;
    } catch (err) {
      return fail(err instanceof PracticeProjectError ? err.message : `Could not make the practice project: ${err instanceof Error ? err.message : String(err)}`);
    }
    const before = (await snapshot())?.project?.path ?? null;
    const command = async (cmd: unknown): Promise<string | null> => {
      const r = CommandResultSchema.parse(await h.call('command', cmd));
      return r.ok ? null : r.error;
    };
    try {
      const switchErr = await command({ type: 'setProject', path });
      if (switchErr) return fail(`Could not open the practice project: ${switchErr}`);
      // Remember the user's own project so the app can offer "back to your project" (never the practice one).
      if (before && before !== path) d.settings.update((s) => ({ ...s, previousProject: before }));
      const startedAt = Date.now();
      const submitErr = await command({ type: 'submitGoal', text: SAMPLE_GOAL_TEXT, budgetTokens: est.tokensHigh });
      if (submitErr) return fail(`Could not start the sample goal: ${submitErr}`);
      const goal = (await snapshot())?.goals.find((g) => g.text === SAMPLE_GOAL_TEXT && g.createdAt >= startedAt - 1_000);
      if (!goal) return fail('The sample goal was sent, but the hive did not list it. Check the Queen screen.');
      d.settings.update((s) => ({ ...s, sample: { goalId: goal.id, practicePath: path, startedAt } }));
      return StartSampleResultSchema.parse({ ok: true, goalId: goal.id, practicePath: path, state: await state() });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
}
