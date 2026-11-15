import { type BrowserWindow, type IpcMainInvokeEvent, dialog, ipcMain } from 'electron';
import {
  BrainAskEstimateSchema,
  BrainAskRequestSchema,
  BrainAskResultSchema,
  BrainDashboardViewSchema,
  BrainEditRequestSchema,
  BrainEditResultSchema,
  BrainGraphRequestSchema,
  BrainGraphViewSchema,
  BrainHitViewSchema,
  BrainRecordViewSchema,
  BrainSearchRequestSchema,
  CasteViewSchema,
  BudgetsViewSchema,
  CadenceRunViewSchema,
  CadenceRunsRequestSchema,
  EngineCardSchema,
  EngineIdSchema,
  EngineInstallResultSchema,
  type HivePush,
  LibraryImportResultSchema,
  LibraryItemDetailSchema,
  LibrarySearchRequestSchema,
  LibrarySearchResultSchema,
  ChangesRequestSchema,
  ChangesViewSchema,
  CodeLookupRequestSchema,
  CodeLookupResultSchema,
  CommandResultSchema,
  DigestViewSchema,
  HIVE_IPC,
  HiveCommandSchema,
  HiveSnapshotSchema,
  ProjectViewSchema,
} from '@insectoids/shared';
import type { BrainClient } from '@insectoids/brain-service';
import type { BrainHost } from './brain-host';
import { EngineInstaller, fakeInstallDeps, hasToolOnPath, runPlan } from './engine-install';

interface Deps {
  host: () => BrainHost | null;
  window: () => BrowserWindow | null;
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
  /** Pushes to the window (C4: engine install output). */
  push?: (p: HivePush) => void;
  /** A cadence was deleted (Phase 3 A4: its webhook secret goes too). */
  cadenceDeleted?: (id: string) => void;
}

/** Same rule as every id in the hive contract. */
const RecordId = ChangesRequestSchema.shape.cardId;
/** A library item name (Phase 2 C1): same length rule as ids. */
const LibraryItemName = RecordId;

/**
 * The hive's IPC (App 07 / Phase 1 Step 8). Every input is validated before it reaches the host,
 * and every reply is validated before it reaches the renderer.
 */
export function registerHiveIpc(d: Deps): void {
  const host = (): BrainHost => {
    const h = d.host();
    if (!h) throw new Error('The Brain is not running.');
    return h;
  };
  const handle = (channel: string, fn: (arg: unknown) => Promise<unknown>): void => {
    ipcMain.handle(channel, async (event, arg: unknown) => {
      d.assertTrustedSender(event);
      return fn(arg);
    });
  };

  handle(HIVE_IPC.snapshot, async () => HiveSnapshotSchema.parse(await host().call('snapshot')));

  handle(HIVE_IPC.command, async (arg) => {
    const cmd = HiveCommandSchema.parse(arg);
    const r = CommandResultSchema.parse(await host().call('command', cmd));
    if (r.ok && cmd.type === 'deleteCadence') d.cadenceDeleted?.(cmd.id);
    return r;
  });

  handle(HIVE_IPC.changes, async (arg) => ChangesViewSchema.parse(await host().call('changes', ChangesRequestSchema.parse(arg))));

  handle(HIVE_IPC.brainSearch, async (arg) => {
    const req = BrainSearchRequestSchema.parse(arg);
    if (!req.query) {
      const params = { ...(req.kinds ? { kinds: req.kinds } : {}), ...(req.includeHistory ? { includeHistory: true } : {}) };
      return BrainHitViewSchema.array().parse(await host().call('brainRecent', params));
    }
    const project = ProjectViewSchema.nullable().parse(await host().call('project'));
    // As the user: the project's shelf plus global (Memory 01-D2).
    const hits = await host().read((c) =>
      c.search({
        query: req.query,
        shelf: project?.shelf ?? 'global',
        limit: 30,
        ...(req.kinds ? { kinds: req.kinds } : {}),
        ...(req.includeHistory ? { includeHistory: true } : {}),
      }),
    );
    // Words + meaning when meaning search is on (the service embeds the query in the Brain host); each hit says how it was found.
    return BrainHitViewSchema.array().parse(hits.map(({ id, kind, shelf, title, summary, match, status }) => ({ id, kind, shelf, title, summary, match, status })));
  });

  // Ask the Brain (Phase 4 A1): one short read-only run over Brain records; the estimate is a read.
  handle(HIVE_IPC.brainAsk, async (arg) => BrainAskResultSchema.parse(await host().call('brainAsk', BrainAskRequestSchema.parse(arg))));
  handle(HIVE_IPC.brainAskEstimate, async () => BrainAskEstimateSchema.parse(await host().call('brainAskEstimate')));

  // The code map (Phase 2 B4): read-only lookups on the current project's map, answered by the Brain host.
  handle(HIVE_IPC.codeLookup, async (arg) => CodeLookupResultSchema.parse(await host().call('codeLookup', CodeLookupRequestSchema.parse(arg))));

  // Brain screens (Phase 2 B5): the graph and the dashboard are reads; the edit is the user's, through the single writer.
  handle(HIVE_IPC.brainGraph, async (arg) => BrainGraphViewSchema.parse(await host().call('brainGraph', BrainGraphRequestSchema.parse(arg ?? {}))));
  handle(HIVE_IPC.brainDashboard, async () => BrainDashboardViewSchema.parse(await host().call('brainDashboard')));
  handle(HIVE_IPC.brainEdit, async (arg) => BrainEditResultSchema.parse(await host().call('brainEdit', BrainEditRequestSchema.parse(arg))));

  // Library screen (Phase 2 C1): read-only views of the castes and the catalog in the Brain.
  handle(HIVE_IPC.libraryCastes, async () => CasteViewSchema.array().parse(await host().call('libraryCastes')));
  handle(HIVE_IPC.librarySearch, async (arg) => LibrarySearchResultSchema.parse(await host().call('librarySearch', LibrarySearchRequestSchema.parse(arg ?? {}))));
  handle(HIVE_IPC.libraryItem, async (arg) => LibraryItemDetailSchema.nullable().parse(await host().call('libraryItem', LibraryItemName.parse(arg))));

  handle(HIVE_IPC.brainRecord, async (arg) => {
    const id = RecordId.parse(arg);
    // Read-only: survives a Brain crash-and-restart mid-read (BrainHost.read waits and retries once).
    return host().read(async (c) => recordView(c, id));
  });

  async function recordView(c: BrainClient, id: string) {
    const rec = await c.get(id);
    if (!rec) return null;
    const [history, links] = await Promise.all([c.history(id), c.links(id)]);
    const titled = await Promise.all(
      links.map(async (l) => {
        const other = await c.get(l.id);
        return other ? { id: l.id, rel: l.rel, direction: l.direction, title: other.title } : null;
      }),
    );
    const live = titled.filter((l) => l !== null);
    return BrainRecordViewSchema.parse({
      id: rec.id,
      kind: rec.kind,
      shelf: rec.shelf,
      owner: rec.owner,
      title: rec.title,
      body: rec.body,
      summary: rec.summary,
      trust: rec.trust,
      source: rec.source,
      version: rec.version,
      archived: rec.archived,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      history: history.map(({ version, change, title, trust, changedBy, changedAt }) => ({ version, change, title, trust, changedBy, changedAt })),
      links: live,
      // B2: use and importance, time-aware facts, merges.
      usage: { reads: rec.reads, helped: rec.helped, lastUsedAt: rec.lastUsedAt, importance: rec.importance },
      validFrom: rec.validFrom,
      validTo: rec.validTo,
      supersededBy: rec.supersededBy ? { id: rec.supersededBy, title: (await c.get(rec.supersededBy))?.title ?? rec.supersededBy } : null,
      supersedes: live.filter((l) => l.rel === 'supersedes' && l.direction === 'out').map(({ id, title }) => ({ id, title })),
      archivedReason: rec.archivedReason,
      mergedFrom: live.filter((l) => l.rel === 'merged_into' && l.direction === 'in').map(({ id, title }) => ({ id, title })),
    });
  }

  // C4: the Budgets screen (read-only).
  handle(HIVE_IPC.budgets, async () => BudgetsViewSchema.parse(await host().call('budgets')));

  // Phase 3 A1: a cadence's run history (read-only).
  handle(HIVE_IPC.cadenceRuns, async (arg) => CadenceRunViewSchema.array().parse(await host().call('cadenceRuns', CadenceRunsRequestSchema.parse(arg))));

  // Phase 3 B1: the "while you were away" digest (read-only; "Got it" is the markDigestSeen command).
  handle(HIVE_IPC.digest, async () => DigestViewSchema.parse(await host().call('digest')));

  // C4: one-click engine install with consent (04-D6). The command comes from the engine's adapter (via its
  // card in the host), never from the renderer. Under e2e no real installer ever runs.
  const e2e = process.env['INSECTOIDS_E2E'] === '1';
  const installer = new EngineInstaller({
    card: async (id) => {
      const c = await host().call('engineCard', { id });
      return c ? EngineCardSchema.parse(c) : null;
    },
    recheck: async (id) => {
      if (e2e) await host().call('e2eEngineInstalled', { id });
      else await host().call('command', { type: 'checkEngine' });
    },
    push: (p) => d.push?.(p),
    ...(e2e ? fakeInstallDeps(process.env['INSECTOIDS_E2E_FAKE_INSTALL'] ?? 'ok') : { hasTool: (t: string) => hasToolOnPath(t), run: runPlan }),
  });
  handle(HIVE_IPC.engineInstall, async (arg) => EngineInstallResultSchema.parse(await installer.install(EngineIdSchema.parse(arg))));

  // C3: import a skill or agent folder. Under e2e a fixture path replaces the dialog (tests can't click it).
  handle(HIVE_IPC.libraryImport, async () => {
    let path = process.env['INSECTOIDS_E2E'] === '1' ? process.env['INSECTOIDS_E2E_IMPORT_PATH'] : undefined;
    if (!path) {
      const win = d.window();
      const options = { title: 'Choose a skill or agent folder (it holds a SKILL.md or an AGENT.md)', properties: ['openDirectory' as const] };
      const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (res.canceled || !res.filePaths[0]) return LibraryImportResultSchema.parse({ status: 'cancelled' });
      path = res.filePaths[0];
    }
    return LibraryImportResultSchema.parse(await host().call('libraryImport', { path }));
  });

  handle(HIVE_IPC.pickProject, async () => {
    const win = d.window();
    const options = { title: 'Choose your project folder', properties: ['openDirectory' as const] };
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const path = res.filePaths[0];
    if (res.canceled || !path) return null;
    const r = CommandResultSchema.parse(await host().call('command', { type: 'setProject', path }));
    if (!r.ok) throw new Error(r.error);
    return ProjectViewSchema.nullable().parse(await host().call('project'));
  });
}
