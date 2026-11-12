import { type BrowserWindow, type IpcMainInvokeEvent, dialog, ipcMain } from 'electron';
import type { BrainClient } from '@insectoids/brain-service';
import {
  type AboutQuestionId,
  HiveSnapshotSchema,
  PresetSchema,
  SETUP_IPC,
  SaveAboutSchema,
  type SetupResult,
  SetupResultSchema,
  type SetupState,
  SetupStateSchema,
} from '@insectoids/shared';
import { type AppSettingsStore, limitsFor } from './app-settings';
import type { BrainHost } from './brain-host';
import { ABOUT_SOURCE, aboutTitle, buildChecklist, findAboutRecords } from './setup-model';

export interface SetupDeps {
  settings: AppSettingsStore;
  host: () => BrainHost | null;
  window: () => BrowserWindow | null;
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
    return SetupStateSchema.parse({
      completed,
      completedAt: s.onboarding.completedAt ?? null,
      brainDir: d.settings.brainDir,
      defaultBrainDir: d.settings.defaultBrainDir,
      preset: s.preset,
      aboutAnswered: [...about.keys()],
      checklist: buildChecklist({
        completed,
        engineReady: snap ? snap.engine.state === 'ready' || snap.engine.state === 'fake' : false,
        aboutAnswered: about.size,
        hasProject: Boolean(snap?.project),
      }),
    });
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
}
