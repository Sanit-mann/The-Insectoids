import { type Page, expect, test } from '@playwright/test';
import type { BrainAskResult, BrainRecordView, HiveApi } from '@insectoids/shared';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * Ask the Brain (Phase 4 A1; Memory 01): a plain-words question answered only from Brain records, with citations.
 *
 * - `hive.brainAsk({ question })` finds current records (words + meaning), gives them to one short read-only run as
 *   numbered sources, and keeps only the [n] markers that point at a source. Nothing found → `unknown` with no AI
 *   run (tokens 0). An answer that cites nothing → `unknown` with the sources it found listed.
 * - `saveBrainAnswer` keeps an answer as an unconfirmed `update` note (source "Ask the Brain") that links to every
 *   record it cited with rel `cites`.
 *
 * The scripted engine answers an ask with a short text citing [1] (and [2] when there are 2+ sources), and replies
 * UNKNOWN when the question has the word "unknowable". Records come from the backend's e2e seed
 * (INSECTOIDS_E2E_BRAIN_SEED): a "Hosting provider" fact (Netlify) replaced by a newer one (Vercel), and more.
 */

// ---- helpers -------------------------------------------------------------------------------------

/** About the seeded current "Hosting provider" fact; the words match it (and the old, superseded one). */
const HOSTING_QUESTION = 'What is the hosting provider?';

const ask = (win: Page, question: string): Promise<BrainAskResult> =>
  win.evaluate((q) => (globalThis as unknown as AppWindow).insectoids.hive.brainAsk({ question: q }), question);
const record = (win: Page, id: string): Promise<BrainRecordView | null> =>
  win.evaluate((i) => (globalThis as unknown as AppWindow).insectoids.hive.brainRecord(i), id);
const command = (win: Page, cmd: Parameters<HiveApi['command']>[0]) =>
  win.evaluate((c) => (globalThis as unknown as AppWindow).insectoids.hive.command(c), cmd);
const search = (win: Page, query: string, includeHistory = false) =>
  win.evaluate(
    ([q, h]) => (globalThis as unknown as AppWindow).insectoids.hive.brainSearch({ query: q, ...(h ? { includeHistory: true } : {}) }),
    [query, includeHistory] as const,
  );

async function idOf(win: Page, title: string): Promise<string> {
  const hit = (await search(win, title)).find((h) => h.title === title);
  if (!hit) throw new Error(`The seeded Brain has no current "${title}".`);
  return hit.id;
}

/** The numbers of every [n] marker in an answer. */
function markers(answer: string): number[] {
  return [...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
}

/** Text without [..] markers, whitespace collapsed (to compare an answer with the note it was kept as). */
function plain(text: string): string {
  return text.replace(/\[[^\]\r\n]*\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Launch with the e2e Brain seed and wait until the seed is searchable. */
async function launchSeeded(): Promise<LaunchedApp> {
  const t = await launchApp({ env: { INSECTOIDS_E2E_BRAIN_SEED: '1' } });
  await expect(t.win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  // The seed is written when the project opens; wait until it is searchable.
  await expect.poll(async () => (await search(t.win, 'hosting provider')).length, { timeout: 15_000 }).toBeGreaterThan(0);
  return t;
}

/** The answered result, or a failure that shows what came back instead. */
function expectAnswered(r: BrainAskResult): Extract<BrainAskResult, { status: 'answered' }> {
  expect(r.status, JSON.stringify(r)).toBe('answered');
  if (r.status !== 'answered') throw new Error('not answered');
  return r;
}

// ---- the API, on the seeded Brain ------------------------------------------------------------------

test.describe('asking the seeded Brain through the API', () => {
  test.describe.configure({ mode: 'serial' });

  let t: LaunchedApp;

  test.beforeAll(async () => {
    t = await launchSeeded();
  });

  test.afterAll(async () => {
    await t?.close();
  });

  test('the estimate says what a question costs before asking', async () => {
    const e = await t.win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.brainAskEstimate());
    expect(e.canAsk, e.message).toBe(true);
    expect(e.message.trim()).not.toBe('');
    expect(e.tokensLow).toBeGreaterThanOrEqual(0);
    expect(e.tokensHigh).toBeGreaterThanOrEqual(e.tokensLow);
    if (e.costUsdHigh !== null) expect(e.costUsdHigh).toBeGreaterThanOrEqual(0);
  });

  test('a question about something in the Brain is answered, and every citation is a real, current record', async () => {
    const { win } = t;
    const r = expectAnswered(await ask(win, HOSTING_QUESTION));

    expect(r.question).toBe(HOSTING_QUESTION);
    expect(r.answer.trim()).not.toBe('');
    expect(r.tokens).toBeGreaterThanOrEqual(0);
    expect(r.costUsd).toBeGreaterThanOrEqual(0);
    expect(r.citations.length).toBeGreaterThanOrEqual(1);
    expect(r.sourcesGiven).toBeGreaterThanOrEqual(r.citations.length);

    // Citations: in number order, no number or record twice.
    const ns = r.citations.map((c) => c.n);
    expect(ns).toEqual([...ns].sort((a, b) => a - b));
    expect(new Set(ns).size).toBe(ns.length);
    expect(new Set(r.citations.map((c) => c.id)).size).toBe(r.citations.length);

    // Every [n] in the answer is one of the citations, and every citation is cited in the answer.
    const cited = markers(r.answer);
    expect(cited.length, `the answer cites something: "${r.answer}"`).toBeGreaterThan(0);
    for (const n of cited) expect(ns, `[${n}] in "${r.answer}"`).toContain(n);
    for (const n of ns) expect(cited, `citation ${n} appears in the answer`).toContain(n);

    // Every citation is a real record, and the citation describes it truly.
    for (const c of r.citations) {
      const rec = await record(win, c.id);
      expect(rec, `citation ${c.n} (${c.id}) is a record`).not.toBeNull();
      if (!rec) continue;
      expect(rec).toMatchObject({ id: c.id, kind: c.kind, shelf: c.shelf, title: c.title, trust: c.trust, archived: false });
      // Current records only: nothing replaced.
      expect(rec.validTo, `${c.title} is current`).toBeNull();
    }

    // It answers from the current "Hosting provider", never from the replaced one.
    expect(r.citations.map((c) => c.title)).toContain('Hosting provider');
    const old = (await search(win, 'hosting provider', true)).find((h) => h.status === 'superseded');
    expect(old, 'the seed has a superseded hosting fact').toBeDefined();
    expect(r.citations.map((c) => c.id)).not.toContain(old!.id);
  });

  test('when the run can\'t answer from the sources, it says the Brain doesn\'t know and lists what it found', async () => {
    const { win } = t;
    // The scripted engine replies UNKNOWN to a question with "unknowable"; the words still find the hosting fact.
    const q = 'Is the hosting provider unknowable?';
    const r = await ask(win, q);
    expect(r.status, JSON.stringify(r)).toBe('unknown');
    if (r.status !== 'unknown') return;
    expect(r.question).toBe(q);
    expect(r.message).toMatch(/doesn.t know|don.t answer/i);
    expect(r.sources.length).toBeGreaterThanOrEqual(1);
    expect(r.sources.map((s) => s.title)).toContain('Hosting provider');
    for (const s of r.sources) expect(await record(win, s.id), `source ${s.n} (${s.id}) is a record`).not.toBeNull();
    // An AI run did happen here (it read the sources).
    expect(r.tokens).toBeGreaterThanOrEqual(0);
    expect(r.costUsd).toBeGreaterThanOrEqual(0);
  });

  test('a question about nothing in the Brain is "unknown" without any AI run', async () => {
    const r = await ask(t.win, 'Where does the zorblax quuxfrob wibbleton live?');
    expect(r.status, JSON.stringify(r)).toBe('unknown');
    if (r.status !== 'unknown') return;
    expect(r.sources).toEqual([]);
    expect(r.tokens).toBe(0);
    expect(r.costUsd).toBe(0);
    expect(r.message).toMatch(/doesn.t know/i);
  });

  test('"saveBrainAnswer" keeps the answer as an unconfirmed update note that cites its records', async () => {
    const { win } = t;
    const r = expectAnswered(await ask(win, HOSTING_QUESTION));
    const citationIds = r.citations.map((c) => c.id);

    // Links into the first cited record before saving, so the new note is the one that appears.
    const firstId = citationIds[0]!;
    const linksBefore = new Set((await record(win, firstId))!.links.map((l) => `${l.direction}:${l.rel}:${l.id}`));

    expect(await command(win, { type: 'saveBrainAnswer', question: r.question, answer: r.answer, citationIds })).toEqual({ ok: true });

    // The note shows up as a `cites` link into the cited record.
    let noteId = '';
    await expect
      .poll(
        async () => {
          const rec = await record(win, firstId);
          const link = rec?.links.find((l) => l.direction === 'in' && l.rel === 'cites' && !linksBefore.has(`${l.direction}:${l.rel}:${l.id}`));
          noteId = link?.id ?? '';
          return noteId;
        },
        { timeout: 10_000 },
      )
      .not.toBe('');

    const note = await record(win, noteId);
    expect(note).not.toBeNull();
    if (!note) return;
    expect(note.kind).toBe('update');
    expect(note.trust).toBe('unconfirmed');
    expect(note.source ?? '').toMatch(/Ask the Brain/);
    expect(note.archived).toBe(false);
    expect(plain(note.body)).toContain(plain(r.answer));

    // It links out (`cites`) to every record the answer cited, and each of them links back in.
    const out = note.links.filter((l) => l.direction === 'out' && l.rel === 'cites').map((l) => l.id);
    expect([...out].sort()).toEqual([...citationIds].sort());
    for (const id of citationIds) {
      const cited = await record(win, id);
      expect(cited?.links.some((l) => l.direction === 'in' && l.rel === 'cites' && l.id === noteId), `${id} links back to the note`).toBe(true);
    }

    // It is a normal Brain record: search finds it by its title.
    await expect
      .poll(async () => (await search(win, note.title)).map((h) => h.id), { timeout: 10_000 })
      .toContain(noteId);
  });
});

// ---- an empty Brain ------------------------------------------------------------------------------

test.describe('asking an empty Brain', () => {
  let t: LaunchedApp;

  test.beforeAll(async () => {
    // No seed: a fresh profile and project.
    t = await launchApp();
    await expect(t.win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  });

  test.afterAll(async () => {
    await t?.close();
  });

  test('says the Brain doesn\'t know, lists no sources and spends no tokens', async () => {
    const r = await ask(t.win, 'What is the hosting provider for the zorblax site?');
    expect(r.status, JSON.stringify(r)).toBe('unknown');
    if (r.status !== 'unknown') return;
    expect(r.sources).toEqual([]);
    expect(r.tokens).toBe(0);
    expect(r.costUsd).toBe(0);
    expect(r.message).toMatch(/doesn.t know/i);
  });
});

// ---- the Brain screen ----------------------------------------------------------------------------

test.describe('the "Ask the Brain" box on the Brain screen', () => {
  test.describe.configure({ mode: 'serial' });

  let t: LaunchedApp;

  test.beforeAll(async () => {
    t = await launchSeeded();
    const { win } = t;
    await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Brain' }).click();
    await win.getByRole('tablist', { name: 'Brain view' }).getByRole('tab', { name: 'Notes' }).click();
  });

  test.afterAll(async () => {
    await t?.close();
  });

  test('shows the cost first; an answer cites a record that opens in the reader; "Keep as a note" says it was kept', async () => {
    const { win } = t;
    // the Ask panel on the Notes view.
    const panel = win.getByTestId('brain-ask');
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // Before the first question: the estimate, and no result yet.
    // estimate line; its wording follows BrainAskEstimate.message ("About 3,000–8,000 tokens …" or free).
    await expect(panel.getByTestId('brain-ask-estimate')).toBeVisible();
    await expect(panel.getByTestId('brain-ask-estimate')).toContainText(/tokens?|free/i);
    await expect(panel.getByTestId('brain-ask-result')).toHaveCount(0);

    // textarea labelled "Ask the Brain a question" and the "Ask" button.
    await panel.getByLabel('Ask the Brain a question').fill(HOSTING_QUESTION);
    await panel.getByRole('button', { name: 'Ask', exact: true }).click();

    // the result block with data-status.
    const result = panel.getByTestId('brain-ask-result');
    await expect(result).toHaveAttribute('data-status', 'answered', { timeout: 20_000 });
    await expect(result).toContainText(/\S/);

    // citation buttons named "Source n: <title>".
    const citation = result.getByRole('button', { name: /^Source 1: / }).first();
    await expect(citation).toBeVisible();
    const label = (await citation.getAttribute('aria-label')) ?? (await citation.textContent()) ?? '';
    const title = /Source 1:\s*(.+)$/.exec(label.trim())?.[1]?.trim() || 'Hosting provider';
    const citedId = await idOf(win, title);

    await citation.click();
    await expect(win.getByTestId('brain-reader').getByRole('heading', { name: title })).toBeVisible({ timeout: 10_000 });

    // Keep the answer: the panel confirms in words, and the note really links to the cited record.
    // "Keep as a note" button and its confirmation text.
    await panel.getByRole('button', { name: 'Keep as a note' }).click();
    await expect(panel).toContainText(/kept|saved/i, { timeout: 10_000 });
    await expect
      .poll(async () => (await record(win, citedId))?.links.some((l) => l.direction === 'in' && l.rel === 'cites') ?? false, { timeout: 10_000 })
      .toBe(true);
  });

  test('a question the sources don\'t answer says so and lists what it found', async () => {
    const { win } = t;
    const panel = win.getByTestId('brain-ask');
    await panel.getByLabel('Ask the Brain a question').fill('Is the hosting provider unknowable?');
    await panel.getByRole('button', { name: 'Ask', exact: true }).click();

    const result = panel.getByTestId('brain-ask-result');
    await expect(result).toHaveAttribute('data-status', 'unknown', { timeout: 20_000 });
    await expect(result).toContainText(/doesn.t know|don.t answer/i);
    // the found records listed under an unknown answer.
    await expect(panel.getByTestId('brain-ask-source').first()).toBeVisible();
    await expect(panel.getByTestId('brain-ask-source').filter({ hasText: 'Hosting provider' }).first()).toBeVisible();
  });
});
