import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Brain, openBrain } from '@insectoids/brain';
import { EXPORT_FOLDER_NAME, EXPORT_MARKER, ObsidianExportResultSchema } from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportMessage, exportObsidian, shelfNamer } from '../brain-host/obsidian-export';

/** The host's side of the Obsidian export (Phase 3 C2), on a real Brain in a temp folder. */
let root: string;
let brain: Brain;
const NOW = Date.parse('2026-11-14T12:00:00Z');
const ant = { type: 'agent' as const, id: 'Ant-1' };
const project = { shelf: 'shop-site', name: 'Shop site' };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-obsidian-host-'));
  mkdirSync(join(root, 'brain'));
  brain = openBrain(join(root, 'brain', 'brain.db'));
});
afterEach(() => {
  brain.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function seed(): void {
  const decision = brain.write({ kind: 'decision', shelf: project.shelf, title: 'Take payments by card only', body: 'Only card payments at launch.' }, ant).id;
  const task = brain.write({ kind: 'task', shelf: project.shelf, title: 'Build the order summary page', body: 'Show the items and the total.' }, ant).id;
  brain.link(task, decision, 'implements');
  brain.write({ kind: 'fact', shelf: 'global', title: 'Hosting provider', body: 'The site is hosted on Vercel.' }, ant);
}

describe('exportObsidian in the Brain host (Phase 3 C2)', () => {
  it('writes the vault with shelves named after the project and Global, and says what it did', () => {
    seed();
    const dir = join(root, 'Notes');
    mkdirSync(dir);
    const r = ObsidianExportResultSchema.parse(exportObsidian({ brain, request: { dir }, now: NOW, project }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const vault = join(dir, EXPORT_FOLDER_NAME);
    expect(r.path).toBe(vault);
    expect(r).toMatchObject({ notes: 3, shelves: 2, redacted: 0, skipped: 0, at: NOW });
    expect(r.links).toBeGreaterThanOrEqual(1);
    expect(r.message).toBe(`Exported 3 notes from 2 shelves to ${vault}.`);
    expect(existsSync(join(vault, 'Shop site'))).toBe(true);
    expect(existsSync(join(vault, 'Global'))).toBe(true);
    expect(existsSync(join(vault, 'README.md'))).toBe(true);
    expect(existsSync(join(vault, EXPORT_MARKER))).toBe(true);
    // A second export replaces its own files (the marker says which).
    const again = exportObsidian({ brain, request: { dir, includeArchived: true }, now: NOW + 1, project });
    expect(again.ok).toBe(true);
  });

  it('without an open project the shelf keeps its own name', () => {
    seed();
    const dir = join(root, 'Notes');
    const r = exportObsidian({ brain, request: { dir }, now: NOW, project: null });
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, EXPORT_FOLDER_NAME, 'shop-site'))).toBe(true);
  });

  it("a writer refusal comes back as { ok: false } in words: an 'Insectoids Brain' folder the app didn't make is left alone", () => {
    seed();
    const dir = join(root, 'Notes');
    const theirs = join(dir, EXPORT_FOLDER_NAME);
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, 'my note.md'), 'mine');
    const r = exportObsidian({ brain, request: { dir }, now: NOW, project });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('was not made by The Insectoids'), cancelled: false });
    expect(readFileSync(join(theirs, 'my note.md'), 'utf8')).toBe('mine');
  });

  it('a bad request comes back as { ok: false }, never thrown', () => {
    for (const request of [undefined, {}, { dir: '' }, { dir: 42 }]) {
      const r = exportObsidian({ brain, request, now: NOW, project });
      expect(r.ok).toBe(false);
    }
  });
});

describe('the export in words', () => {
  it('counts notes and shelves, and names removed or left-out secrets only when there were any', () => {
    const path = 'D:\\Notes\\Insectoids Brain';
    expect(exportMessage({ notes: 214, shelves: 3, path, redacted: 0, skipped: 0 })).toBe(`Exported 214 notes from 3 shelves to ${path}.`);
    expect(exportMessage({ notes: 1, shelves: 1, path, redacted: 1, skipped: 1 })).toBe(
      `Exported 1 note from 1 shelf to ${path}. 1 note had a secret removed. 1 note was left out because it looked like it held a secret.`,
    );
    expect(exportMessage({ notes: 5, shelves: 2, path, redacted: 2, skipped: 3 })).toBe(
      `Exported 5 notes from 2 shelves to ${path}. 2 notes had a secret removed. 3 notes were left out because they looked like they held a secret.`,
    );
  });

  it('names shelves: Global, the open project by its folder name, others as they are', () => {
    const name = shelfNamer(project);
    expect(name('global')).toBe('Global');
    expect(name('shop-site')).toBe('Shop site');
    expect(name('other-project')).toBe('other-project');
    expect(shelfNamer(null)('shop-site')).toBe('shop-site');
  });
});
