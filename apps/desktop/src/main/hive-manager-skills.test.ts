import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { demoEngine } from '@insectoids/harness';
import { HiveSnapshotSchema, LibraryImportResultSchema, LibraryItemDetailSchema, LibrarySearchResultSchema } from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HiveManager } from '../brain-host/hive-manager';

/** Skill proposals, imports and retirement in the host (Phase 2 C3; Capabilities 03-D5, D6). */
const libraryDir = fileURLToPath(new URL('../../../../library', import.meta.url));
const fixtures = fileURLToPath(new URL('../../e2e/fixtures/library', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let brain: Brain;
let manager: HiveManager | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-skills-hm-'));
  repo = join(root, 'site');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'README.md'), '# Site\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  brain = openBrain(':memory:');
  manager = null;
});

afterEach(async () => {
  await manager?.dispose();
  await new Promise((r) => setTimeout(r, 50));
  brain.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function make(o: { project?: boolean; skillProposals?: boolean } = {}): Promise<HiveManager> {
  manager = new HiveManager({
    brain,
    tokens: null,
    doors: null,
    userDataDir: join(root, 'userData'),
    libraryDir,
    engine: 'fake',
    engineOverride: demoEngine({ queenMs: 5, insectMs: 20, inspectorMs: 5 }),
    ...(o.project === false ? {} : { project: repo }),
    push: () => {},
    tickMs: 20,
    seed: 1,
    geminiDetect: async () => ({ status: 'missing' }),
    ...(o.skillProposals === false ? { skillProposals: false } : {}),
  });
  await manager.init();
  return manager;
}

async function until<T>(what: string, read: () => T | undefined | null | false, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const snap = (m: HiveManager) => HiveSnapshotSchema.parse(m.snapshot());
const item = (m: HiveManager, name: string) => LibraryItemDetailSchema.nullable().parse(m.libraryItem(name));
const ok = async (m: HiveManager, cmd: Parameters<HiveManager['command']>[0]) => expect(await m.command(cmd)).toEqual({ ok: true });

describe('imports (03-D5)', () => {
  it('a clean skill waits as a draft; approved it becomes ready and can be switched on', async () => {
    const m = await make({ project: false });
    const r = LibraryImportResultSchema.parse(m.libraryImport(join(fixtures, 'tidy-commit-messages')));
    expect(r).toMatchObject({ status: 'imported', name: 'tidy-commit-messages' });
    const it1 = item(m, 'tidy-commit-messages')!;
    expect(it1.item).toMatchObject({ status: 'draft', origin: 'imported', scan: { verdict: 'clean' } });
    expect(it1.body).toContain('# Tidy commit messages');
    const approval = snap(m).approvals.find((a) => a.kind === 'skill_import' && a.status === 'waiting')!;
    expect(approval).toMatchObject({ from: 'Librarian', ifYouSayYes: 'It becomes a Ready skill the hive can switch on for cards that need it.' });
    expect(it1.item.approvalId).toBe(approval.id);
    expect(brain.library.isActivatable('tidy-commit-messages')).toBe(false);

    await ok(m, { type: 'approve', approvalId: approval.id });
    expect(item(m, 'tidy-commit-messages')!.item).toMatchObject({ status: 'ready', approvalId: null });
    expect(brain.library.isActivatable('tidy-commit-messages')).toBe(true);
    expect(snap(m).activity.some((a) => /You approved "tidy-commit-messages"/.test(a.message))).toBe(true);
  });

  it('a malicious skill is caught: blocked, kept with its reasons, never asked about or used', async () => {
    const m = await make({ project: false });
    const r = LibraryImportResultSchema.parse(m.libraryImport(join(fixtures, 'quick-setup-helper')));
    expect(r.status).toBe('imported');
    if (r.status !== 'imported') return;
    expect(r.scan.verdict).toBe('blocked');
    const rules = new Set(r.scan.findings.filter((f) => f.severity === 'block').map((f) => f.rule));
    expect(rules).toEqual(new Set(['hidden-instructions', 'risky-script']));
    expect(snap(m).approvals.some((a) => a.kind === 'skill_import')).toBe(false);
    expect(item(m, r.name)!.item).toMatchObject({ status: 'draft', approvalId: null, scan: { verdict: 'blocked' } });
    // Retiring it is allowed; bringing it back is not.
    await ok(m, { type: 'retireLibraryItem', name: r.name });
    expect(await m.command({ type: 'restoreLibraryItem', name: r.name })).toEqual({ ok: false, error: "It failed the safety check, so it can't be used." });
  });

  it('refuses a name already in the library, and a folder that is not an item', async () => {
    const m = await make({ project: false });
    m.libraryImport(join(fixtures, 'tidy-commit-messages'));
    expect(m.libraryImport(join(fixtures, 'tidy-commit-messages'))).toMatchObject({ status: 'error', message: expect.stringContaining('already has an item') });
    expect(m.libraryImport(join(root, 'nothing-here'))).toMatchObject({ status: 'error' });
  });

  it('a "no" retires the draft; restoring it asks again', async () => {
    const m = await make({ project: false });
    m.libraryImport(join(fixtures, 'tidy-commit-messages'));
    const a = snap(m).approvals.find((x) => x.kind === 'skill_import')!;
    await ok(m, { type: 'deny', approvalId: a.id });
    expect(item(m, 'tidy-commit-messages')!.item.status).toBe('retired');
    await ok(m, { type: 'restoreLibraryItem', name: 'tidy-commit-messages' });
    expect(item(m, 'tidy-commit-messages')!.item.status).toBe('draft');
    expect(snap(m).approvals.filter((x) => x.kind === 'skill_import' && x.status === 'waiting')).toHaveLength(1);
  });
});

describe('retiring skills (03-D6)', () => {
  it('the user can retire and restore a ready skill, but never a caste default or a dormant entry', async () => {
    const m = await make({ project: false });
    await ok(m, { type: 'retireLibraryItem', name: 'accessibility' });
    expect(brain.library.isActivatable('accessibility')).toBe(false);
    expect(LibrarySearchResultSchema.parse(m.librarySearch({ statuses: ['retired'] })).items.map((i) => i.name)).toEqual(['accessibility']);
    await ok(m, { type: 'restoreLibraryItem', name: 'accessibility' });
    expect(brain.library.isActivatable('accessibility')).toBe(true);
    expect(await m.command({ type: 'retireLibraryItem', name: 'coding-discipline' })).toMatchObject({ ok: false, error: expect.stringContaining("can't be retired") });
    const dormant = LibrarySearchResultSchema.parse(m.librarySearch({ statuses: ['dormant'], limit: 1 })).items[0]!.name;
    expect(await m.command({ type: 'retireLibraryItem', name: dormant })).toMatchObject({ ok: false, error: expect.stringContaining('Dormant') });
  });

  it('the free audit proposes retiring a skill that keeps failing; yes retires it', async () => {
    const m = await make({ project: false });
    for (let i = 0; i < 5; i++) {
      brain.library.activate(`g.C-${i}`, 0, [{ name: 'accessibility', tokens: 10 }]);
      brain.library.settle(`g.C-${i}`, 0, 'failed');
    }
    await ok(m, { type: 'tidyBrain' });
    const a = snap(m).approvals.find((x) => x.kind === 'skill_retirement' && x.status === 'waiting')!;
    expect(a.title).toBe('Retire the skill "accessibility"?');
    expect(a.whyItNeedsYou).toContain('passed only 0 of 5');
    await ok(m, { type: 'approve', approvalId: a.id });
    expect(item(m, 'accessibility')!.item.status).toBe('retired');
    // Not proposed twice: the next audit finds nothing new to ask.
    await ok(m, { type: 'tidyBrain' });
    expect(snap(m).approvals.filter((x) => x.kind === 'skill_retirement')).toHaveLength(1);
  });
});

describe('skills learned from repeated work (03-D6)', () => {
  it('three similar passed cards → the Librarian drafts a skill → it waits for approval → yes makes it usable', async () => {
    const m = await make();
    await ok(m, { type: 'submitGoal', text: 'Add three greeting pages' });
    const a = await until('a skill proposal', () => snap(m).approvals.find((x) => x.kind === 'skill_proposal' && x.status === 'waiting'));
    expect(a).toMatchObject({ title: 'New skill learned: "greeting-pages"', from: 'Librarian' });
    expect(a.whyItNeedsYou).toContain('3 times');
    const it1 = item(m, 'greeting-pages')!;
    expect(it1.item).toMatchObject({ status: 'draft', origin: 'learned', scan: { verdict: 'clean' } });
    expect(it1.body).toContain('# Greeting pages');
    expect(snap(m).agents.some((l) => l.role === 'librarian' && /Draft a skill/.test(l.title))).toBe(true);
    await ok(m, { type: 'approve', approvalId: a.id });
    expect(brain.library.isActivatable('greeting-pages')).toBe(true);
    // The same work is never proposed again (and not more than once a day anyway).
    expect(brain.library.proposed('coder|friendly greeting page')).toBe(true);
  });

  it('can be switched off', async () => {
    const m = await make({ skillProposals: false });
    await ok(m, { type: 'submitGoal', text: 'Add three greeting pages' });
    await until('the goal to finish its cards', () => snap(m).cards.filter((c) => c.status === 'done').length === 3);
    await new Promise((r) => setTimeout(r, 200));
    expect(snap(m).approvals.some((x) => x.kind === 'skill_proposal')).toBe(false);
  });
});
