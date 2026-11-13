import { type BrowserWindow, type IpcMainInvokeEvent, dialog, ipcMain } from 'electron';
import {
  BrainHitViewSchema,
  BrainRecordViewSchema,
  BrainSearchRequestSchema,
  ChangesRequestSchema,
  ChangesViewSchema,
  CodeLookupRequestSchema,
  CodeLookupResultSchema,
  CommandResultSchema,
  HIVE_IPC,
  HiveCommandSchema,
  HiveSnapshotSchema,
  ProjectViewSchema,
} from '@insectoids/shared';
import type { BrainClient } from '@insectoids/brain-service';
import type { BrainHost } from './brain-host';

interface Deps {
  host: () => BrainHost | null;
  window: () => BrowserWindow | null;
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
}

/** Same rule as every id in the hive contract. */
const RecordId = ChangesRequestSchema.shape.cardId;

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
    return CommandResultSchema.parse(await host().call('command', cmd));
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

  // The code map (Phase 2 B4): read-only lookups on the current project's map, answered by the Brain host.
  handle(HIVE_IPC.codeLookup, async (arg) => CodeLookupResultSchema.parse(await host().call('codeLookup', CodeLookupRequestSchema.parse(arg))));

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
