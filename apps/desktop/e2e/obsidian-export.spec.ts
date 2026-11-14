import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { EXPORT_FOLDER_NAME, EXPORT_MARKER, type HiveApi, SECRET_REMOVED } from '@insectoids/shared';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * Obsidian export (Phase 3 C2; Memory 01-D11, E13): the Brain as a read-only folder of Markdown notes.
 *
 * - Layout: `<picked>/Insectoids Brain/` with README.md, the marker `.insectoids-export.json`, and notes at
 *   `<Shelf>/<Kind plural>/<Title>.md`, each starting with YAML frontmatter and ending with a `## Links` section of
 *   `[[file name|title]]` lines. A superseded fact links to what replaced it.
 * - Secrets never reach a file: `[secret removed]` and `redacted: true`, or the note is left out.
 * - A second export replaces only what the last one wrote (the marker says what); the user's own files stay. An
 *   `Insectoids Brain` folder without the marker is refused.
 *
 * Records come from the backend's e2e seed (INSECTOIDS_E2E_BRAIN_SEED): a superseded "Hosting provider" fact, a
 * decision with a task that implements it, and more. The folder picker is replaced by INSECTOIDS_E2E_EXPORT_FOLDER.
 */

// ---- helpers -------------------------------------------------------------------------------------

const command = (win: Page, cmd: Parameters<HiveApi['command']>[0]) =>
  win.evaluate((c) => (globalThis as unknown as AppWindow).insectoids.hive.command(c), cmd);
const search = (win: Page, query: string, includeHistory = false) =>
  win.evaluate(
    ([q, h]) => (globalThis as unknown as AppWindow).insectoids.hive.brainSearch({ query: q, ...(h ? { includeHistory: true } : {}) }),
    [query, includeHistory] as const,
  );
const exportNow = (win: Page, includeArchived = false) =>
  win.evaluate((a) => (globalThis as unknown as AppWindow).insectoids.brainExport.exportObsidian(a ? { includeArchived: true } : {}), includeArchived);

async function idOf(win: Page, title: string): Promise<string> {
  const hit = (await search(win, title)).find((h) => h.title === title);
  if (!hit) throw new Error(`The seeded Brain has no current "${title}".`);
  return hit.id;
}

async function openBrain(win: Page): Promise<void> {
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Brain' }).click();
}

/** Every file under `dir`, as paths relative to it with `/` separators. Dot folders (.obsidian) are skipped. */
function walk(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!e.name.startsWith('.')) out.push(...walk(full, root));
    } else {
      out.push(relative(root, full).split(sep).join('/'));
    }
  }
  return out;
}

interface Note {
  rel: string;
  text: string;
  frontmatter: string;
  id: string | null;
}

/**
 * The notes the app wrote: every .md file except README.md at the vault root and the user's own files.
 * Frontmatter is the block between the opening `---` and the next `---` line.
 */
function readNotes(vault: string, userFiles: readonly string[] = []): Note[] {
  return walk(vault)
    .filter((rel) => rel.endsWith('.md') && rel !== 'README.md' && !userFiles.includes(rel))
    .map((rel) => {
      const text = readFileSync(join(vault, rel), 'utf8');
      const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
      const frontmatter = fm?.[1] ?? '';
      const id = /^id:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m.exec(frontmatter)?.[1] ?? null;
      return { rel, text, frontmatter, id };
    });
}

/** `[[target]]`, `[[target|title]]` and `[[target#heading]]`: the target part of every wiki link in a text. */
function linkTargets(text: string): string[] {
  return [...text.matchAll(/\[\[([^\]|#\r\n]+)(?:[|#][^\]\r\n]*)?\]\]/g)].map((m) => m[1]!.trim());
}

/**
 * Where a link goes, the way Obsidian resolves it: a vault-relative path (with or without `.md`), or a bare file
 * name that matches a note anywhere in the vault. null when nothing matches.
 */
function resolveLink(vault: string, target: string, notes: readonly Note[]): string | null {
  const withMd = target.endsWith('.md') ? target : `${target}.md`;
  if (existsSync(join(vault, withMd))) return withMd.split(sep).join('/');
  const byName = notes.find((n) => n.rel.split('/').at(-1) === withMd);
  return byName?.rel ?? null;
}

/** Every wiki link in every note resolves to a note that exists in the vault. */
function expectAllLinksResolve(vault: string, notes: readonly Note[]): number {
  let count = 0;
  for (const n of notes) {
    for (const t of linkTargets(n.text)) {
      count++;
      expect(resolveLink(vault, t, notes), `"${n.rel}" links to [[${t}]], which is not in the vault`).not.toBeNull();
    }
  }
  return count;
}

/** The `## Links` section of a note (up to the next heading of the same or higher level, or the end). */
function linksSection(text: string): string {
  const m = /^## Links[ \t]*\r?\n([\s\S]*?)(?=^#{1,2} |(?![\s\S]))/m.exec(text);
  return m?.[1] ?? '';
}

/** The note `from` has a `## Links` line that resolves to the note `to`; returns that line. */
function linkLine(vault: string, from: Note, to: Note, notes: readonly Note[]): string | undefined {
  return linksSection(from.text)
    .split(/\r?\n/)
    .find((line) => linkTargets(line).some((t) => resolveLink(vault, t, notes) === to.rel));
}

function noteWithId(notes: readonly Note[], id: string): Note {
  const n = notes.find((x) => x.id === id);
  if (!n) throw new Error(`No note has id ${id}. Notes: ${notes.map((x) => x.rel).join(', ')}`);
  return n;
}

/** The structure every export must have: README, marker, shelf/kind/title notes with frontmatter, working links. */
function expectWellFormedVault(vault: string, userFiles: readonly string[] = []): Note[] {
  expect(existsSync(join(vault, 'README.md')), 'README.md').toBe(true);
  expect(readFileSync(join(vault, 'README.md'), 'utf8')).toMatch(/read-only/i);
  expect(existsSync(join(vault, EXPORT_MARKER)), EXPORT_MARKER).toBe(true);
  expect(() => JSON.parse(readFileSync(join(vault, EXPORT_MARKER), 'utf8')) as unknown, 'the marker is JSON').not.toThrow();

  const notes = readNotes(vault, userFiles);
  expect(notes.length).toBeGreaterThan(0);
  for (const n of notes) {
    expect(n.rel.split('/'), `"${n.rel}" sits at <Shelf>/<Kind plural>/<Title>.md`).toHaveLength(3);
    expect(n.text.startsWith('---'), `"${n.rel}" starts with frontmatter`).toBe(true);
    expect(n.frontmatter, `"${n.rel}" has frontmatter`).not.toBe('');
    expect(n.id, `"${n.rel}" has an id in its frontmatter`).not.toBeNull();
    expect(n.frontmatter, `"${n.rel}" is tagged with its kind`).toMatch(/insectoids\/[a-z_]+/);
  }
  expectAllLinksResolve(vault, notes);
  return notes;
}

/** The number of notes the result message names ("Exported 12 notes from 1 shelf to …"). */
function noteCount(message: string): number {
  const m = /(\d+)\s+notes?\b/.exec(message);
  if (!m) throw new Error(`The result does not say how many notes: "${message}"`);
  return Number(m[1]);
}

// ---- export, re-export, archived, secrets --------------------------------------------------------

test.describe('export the seeded Brain to an Obsidian vault', () => {
  test.describe.configure({ mode: 'serial' });

  let t: LaunchedApp;
  let picked: string;
  let vault: string;
  /** The user's own files placed in the vault after the first export (vault-relative). */
  const userFiles: string[] = [];
  const userText = 'My own thoughts, written in Obsidian. The app must leave this alone.\n';

  test.beforeAll(async () => {
    picked = mkdtempSync(join(tmpdir(), 'insectoids-e2e-export-'));
    vault = join(picked, EXPORT_FOLDER_NAME);
    t = await launchApp({ env: { INSECTOIDS_E2E_BRAIN_SEED: '1', INSECTOIDS_E2E_EXPORT_FOLDER: picked } });
    await expect(t.win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
    // The seed is written when the project opens; wait until it is searchable.
    await expect.poll(async () => (await search(t.win, 'hosting provider')).length, { timeout: 15_000 }).toBeGreaterThan(0);
  });

  test.afterAll(async () => {
    await t?.close();
    if (picked) rmSync(picked, { recursive: true, force: true, maxRetries: 3 });
  });

  test('"Export to Obsidian" writes a vault: README, marker, shelf/kind notes with frontmatter, and links that resolve', async () => {
    const { win } = t;
    await openBrain(win);
    // the Brain screen's "Export to Obsidian" button.
    const button = win.getByTestId('export-obsidian');
    await expect(button).toHaveText(/Export to Obsidian/);
    await button.click();

    // the result line under the button.
    const result = win.getByTestId('export-result');
    await expect(result).toContainText(/\d+ notes?/, { timeout: 20_000 });
    await expect(result).toContainText(EXPORT_FOLDER_NAME);
    // "Show folder" next to the result. Not clicked: it would open the file manager on the test machine.
    await expect(win.getByRole('button', { name: 'Show folder' })).toBeVisible();

    const notes = expectWellFormedVault(vault);
    expect(notes).toHaveLength(noteCount((await result.textContent()) ?? ''));

    // Notes sit in their shelf's kind folder.
    const fact = noteWithId(notes, await idOf(win, 'Hosting provider'));
    expect(fact.rel).toMatch(/^[^/]+\/Facts\/Hosting provider\.md$/);
    const decision = noteWithId(notes, await idOf(win, 'Take payments by card only'));
    expect(decision.rel).toMatch(/^[^/]+\/Decisions\/Take payments by card only\.md$/);
    const task = noteWithId(notes, await idOf(win, 'Build the order summary page'));
    expect(task.rel).toMatch(/^[^/]+\/Tasks\/Build the order summary page\.md$/);
    expect(fact.frontmatter).toMatch(/^kind:\s*['"]?fact['"]?\s*$/m);

    // Brain links become wiki links: the task implements the decision.
    expect(linkLine(vault, task, decision, notes), 'the task links to its decision').toBeDefined();

    // Current records only by default: the replaced "Hosting provider" (Netlify) is not in the vault.
    const old = (await search(win, 'hosting provider', true)).find((h) => h.status === 'superseded');
    expect(old).toBeDefined();
    expect(notes.find((n) => n.id === old!.id)).toBeUndefined();

    // The marker lists what this export wrote.
    expect(readFileSync(join(vault, EXPORT_MARKER), 'utf8')).toContain('Hosting provider');
  });

  test("exporting again replaces only the app's own notes: a gone record's note goes, the user's files stay", async () => {
    const { win } = t;
    const before = readNotes(vault);
    const taskId = await idOf(win, 'Build the order summary page');
    const taskRel = noteWithId(before, taskId).rel;
    const shelfDir = taskRel.split('/')[0]!;

    // The user's own files: one at the vault root, one inside a folder the app writes to, and Obsidian's settings.
    const own = ['My own notes.md', `${shelfDir}/Facts/My own fact.md`];
    for (const rel of own) {
      writeFileSync(join(vault, rel), userText);
      userFiles.push(rel);
    }
    mkdirSync(join(vault, '.obsidian'), { recursive: true });
    writeFileSync(join(vault, '.obsidian', 'app.json'), '{"livePreview":true}\n');

    // The task leaves the current Brain (archived), so the next default export has no note for it.
    expect(await command(win, { type: 'archiveRecord', id: taskId })).toEqual({ ok: true });

    const r = await exportNow(win);
    expect(r, r.ok ? '' : r.error).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.path.replace(/[\\/]+$/, '').endsWith(EXPORT_FOLDER_NAME)).toBe(true);
    expect(r.message).toMatch(/\d+ notes?/);
    expect(noteCount(r.message)).toBe(r.notes);

    const after = expectWellFormedVault(vault, userFiles);
    expect(after).toHaveLength(r.notes);
    expect(existsSync(join(vault, taskRel)), `${taskRel} was the app's and its record is archived`).toBe(false);
    expect(after.find((n) => n.id === taskId)).toBeUndefined();
    // Every other note from the first export is still there (same ids).
    expect(after.map((n) => n.id).sort()).toEqual(expect.arrayContaining(before.filter((n) => n.id !== taskId).map((n) => n.id)));

    for (const rel of own) expect(readFileSync(join(vault, rel), 'utf8'), `${rel} survives`).toBe(userText);
    expect(readFileSync(join(vault, '.obsidian', 'app.json'), 'utf8')).toBe('{"livePreview":true}\n');
  });

  test('"Include archived notes" adds archived and superseded records; the old fact links to its replacement', async () => {
    const { win } = t;
    await openBrain(win);
    const result = win.getByTestId('export-result');
    const previous = (await result.textContent()) ?? '';

    // the "Include archived notes" checkbox (a checkbox or a switch, found by its label).
    await win.getByLabel('Include archived notes').check();
    await win.getByTestId('export-obsidian').click();
    await expect(result).not.toHaveText(previous, { timeout: 20_000 });
    await expect(result).toContainText(/\d+ notes?/);

    const notes = expectWellFormedVault(vault, userFiles);
    expect(notes).toHaveLength(noteCount((await result.textContent()) ?? ''));

    // The archived task is back, tagged as archived.
    const taskHit = (await search(win, 'Build the order summary page', true)).find((h) => h.title === 'Build the order summary page');
    expect(taskHit?.status).toBe('archived');
    expect(noteWithId(notes, taskHit!.id).frontmatter).toContain('insectoids/archived');

    // Both "Hosting provider" facts are in the vault (the second file name gets " (2)"); the old one links to the new.
    const hits = await search(win, 'hosting provider', true);
    const current = hits.find((h) => h.status === 'current');
    const old = hits.find((h) => h.status === 'superseded');
    expect(current && old).toBeTruthy();
    const currentNote = noteWithId(notes, current!.id);
    const oldNote = noteWithId(notes, old!.id);
    expect(oldNote.rel).not.toBe(currentNote.rel);
    expect([oldNote.rel, currentNote.rel].map((r) => r.split('/').at(-1)).sort()).toEqual(['Hosting provider (2).md', 'Hosting provider.md']);
    expect(oldNote.frontmatter).toContain('insectoids/archived');
    expect(oldNote.frontmatter).toMatch(/^valid_to:\s*\S+/m);
    const line = linkLine(vault, oldNote, currentNote, notes);
    expect(line, 'the superseded fact links to what replaced it').toBeDefined();
    expect(line).toMatch(/replac|supersed/i);

    // The user's files are still there.
    for (const rel of userFiles) expect(readFileSync(join(vault, rel), 'utf8'), `${rel} survives`).toBe(userText);
  });

  test("a secret planted in a record never reaches a file: it's replaced and the note says redacted (or it's left out)", async () => {
    const { app, win } = t;
    // The Brain refuses secrets on every write path (title, body, summary, source), so an e2e-only main hook plants
    // one: the host writes a normal record and swaps the secret into its body through a second connection.

    // Built at run time so secret scanners don't flag this file.
    const secret = ['ghp', '_', 'Q7w2E9r4T6y8U1i3O5p0A2s4D6f8G1h3J5k7'].join('');
    const id = await app.evaluate(
      async (_electron, value) => {
        const hook = (globalThis as unknown as { __insectoidsE2E: { plantSecretRecord: (title: string, body: string) => Promise<{ id: string }> } })
          .__insectoidsE2E;
        return (await hook.plantSecretRecord('Deploy access', `The deploy token is ${value} (keep it safe).`)).id;
      },
      secret,
    );

    const r = await exportNow(win);
    expect(r, r.ok ? '' : r.error).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.redacted + r.skipped).toBeGreaterThanOrEqual(1);

    // Grep every file in the picked folder: notes, README, the marker (walk keeps dot files), anything else.
    for (const rel of walk(picked)) {
      expect(readFileSync(join(picked, rel), 'utf8').includes(secret), `${rel} has the secret`).toBe(false);
    }

    const note = readNotes(vault, userFiles).find((n) => n.id === id);
    if (note) {
      expect(note.frontmatter).toMatch(/^redacted:\s*true\s*$/m);
      expect(note.text).toContain(SECRET_REMOVED);
      expect(r.redacted).toBeGreaterThanOrEqual(1);
    } else {
      expect(r.skipped).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---- a folder the app did not make --------------------------------------------------------------

test.describe('an "Insectoids Brain" folder without the marker', () => {
  test.describe.configure({ mode: 'serial' });

  let t: LaunchedApp;
  let picked: string;
  const theirs = '# My notes\nNot made by Insectoids.\n';

  test.beforeAll(async () => {
    // A fresh picked folder that already has an "Insectoids Brain" folder of the user's own (no marker).
    picked = mkdtempSync(join(tmpdir(), 'insectoids-e2e-export-theirs-'));
    mkdirSync(join(picked, EXPORT_FOLDER_NAME));
    writeFileSync(join(picked, EXPORT_FOLDER_NAME, 'Ideas.md'), theirs);
    t = await launchApp({ env: { INSECTOIDS_E2E_BRAIN_SEED: '1', INSECTOIDS_E2E_EXPORT_FOLDER: picked } });
    await expect(t.win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  });

  test.afterAll(async () => {
    await t?.close();
    if (picked) rmSync(picked, { recursive: true, force: true, maxRetries: 3 });
  });

  test('is refused with an error in words, and nothing in it changes', async () => {
    const { win } = t;
    const r = await exportNow(win);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.cancelled).toBe(false);
    // Words, not a code or a stack: a sentence about the folder it won't overwrite.
    expect(r.error).toMatch(/[A-Za-z]+ [A-Za-z]+ [A-Za-z]+/);
    expect(r.error).toMatch(/Insectoids Brain|overwrite|not made|marker/i);
    expect(r.error).not.toMatch(/\bat .+:\d+:\d+|E[A-Z]{3,}:/);

    // Through the UI too: an error alert ("The export didn't finish") says why, and no result line claims an export.
    await openBrain(win);
    await win.getByTestId('export-obsidian').click();
    await expect(win.getByText("The export didn't finish")).toBeVisible({ timeout: 20_000 });
    await expect(win.getByText(r.error)).toBeVisible();
    await expect(win.getByTestId('export-result')).not.toContainText(/Exported \d+/);

    const dir = join(picked, EXPORT_FOLDER_NAME);
    expect(readdirSync(dir)).toEqual(['Ideas.md']);
    expect(readFileSync(join(dir, 'Ideas.md'), 'utf8')).toBe(theirs);
    expect(existsSync(join(dir, EXPORT_MARKER))).toBe(false);
  });
});
