import { type ConsoleMessage, type Locator, type Page, expect, test } from '@playwright/test';
import type { BrainTimelineEntry, BrainTimelineRequest, BrainTimelineView } from '@insectoids/shared';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * The Brain's Timeline (Phase 4 A3): every change to a record (created, edited, archived, replaced, merged,
 * brought back), newest first, paged by a keyset cursor, filterable by change, by who made it and by title.
 *
 * Two apps:
 * - the seeded Brain (INSECTOIDS_E2E_BRAIN_SEED: records written by the agent "Ant-seed" and the Librarian, with a
 *   "Hosting provider" fact replaced by a newer one) for the API: order, paging, filters, user and agent changes;
 * - the seeded Brain plus 120 more records (the e2e-only `seedRecords` hook, which writes them as the user) for the
 *   screen: day groups, the filters, opening a record, "Show older" and the Dashboard's link.
 *
 * Changes come from: `hive.brainEdit` (the user), `__insectoidsE2E.agentEditRecord` (the agent "e2e-agent", main
 * process only) and `__insectoidsE2E.seedRecords` (the user).
 */

// ---- helpers -------------------------------------------------------------------------------------

const timeline = (win: Page, req: BrainTimelineRequest): Promise<BrainTimelineView> =>
  win.evaluate((r) => (globalThis as unknown as AppWindow).insectoids.hive.brainTimeline(r), req);

const keyOf = (e: Pick<BrainTimelineEntry, 'recordId' | 'version'>): string => `${e.recordId}#${e.version}`;

/** Every entry for `req`, page by page (`before` = the last page's `nextCursor`), checking each cursor on the way. */
async function walkAll(win: Page, req: BrainTimelineRequest, limit: number): Promise<{ entries: BrainTimelineEntry[]; pages: number }> {
  const entries: BrainTimelineEntry[] = [];
  let before: BrainTimelineView['nextCursor'] = null;
  for (let pages = 1; pages <= 200; pages++) {
    const page: BrainTimelineView = await timeline(win, { ...req, limit, ...(before ? { before } : {}) });
    expect(page.entries.length).toBeLessThanOrEqual(limit);
    entries.push(...page.entries);
    if (!page.nextCursor) return { entries, pages };
    // The cursor is the last entry of the page.
    const last = page.entries.at(-1);
    expect(last, 'a page with a next cursor is not empty').toBeDefined();
    expect(page.nextCursor).toEqual({ changedAt: last!.changedAt, recordId: last!.recordId, version: last!.version });
    before = page.nextCursor;
  }
  throw new Error('The timeline did not end within 200 pages.');
}

/** Newest first: time never goes up, and each record's versions come newest first. */
function expectNewestFirst(entries: BrainTimelineEntry[]): void {
  for (let i = 1; i < entries.length; i++) {
    expect(entries[i]!.changedAt, `entry ${i} is not newer than entry ${i - 1}`).toBeLessThanOrEqual(entries[i - 1]!.changedAt);
  }
  const lastVersion = new Map<string, number>();
  for (const e of entries) {
    const seen = lastVersion.get(e.recordId);
    if (seen !== undefined) expect(e.version, `versions of ${e.recordId} newest first`).toBeLessThan(seen);
    lastVersion.set(e.recordId, e.version);
  }
}

async function idOf(win: Page, title: string): Promise<string> {
  const hits = await win.evaluate((q) => (globalThis as unknown as AppWindow).insectoids.hive.brainSearch({ query: q }), title);
  const hit = hits.find((h) => h.title === title);
  if (!hit) throw new Error(`The seeded Brain has no "${title}".`);
  return hit.id;
}

/** The seed is written when the project opens; the Librarian's lessons come last. */
async function waitForSeed(win: Page): Promise<void> {
  await expect(win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await expect
    .poll(async () => (await timeline(win, { scope: 'project', limit: 200 })).entries.some((e) => e.title.includes('Fix the login test')), { timeout: 15_000 })
    .toBe(true);
}

/** Collects console errors and uncaught page errors; each UI test checks it added none. */
function watchErrors(win: Page): string[] {
  const errors: string[] = [];
  win.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  win.on('pageerror', (e: Error) => errors.push(`page error: ${e.message}`));
  return errors;
}

// ---- the API, on the seeded Brain ----------------------------------------------------------------

test.describe('the timeline API', () => {
  test.describe.configure({ mode: 'serial' });

  let t: LaunchedApp;

  test.beforeAll(async () => {
    t = await launchApp({ env: { INSECTOIDS_E2E_BRAIN_SEED: '1' } });
    await waitForSeed(t.win);
  });

  test.afterAll(async () => {
    await t?.close();
  });

  test('newest first; small pages walk the same entries as one big page; filters by change, title and person; a replaced fact says so', async () => {
    const { win } = t;

    // One big page: the whole seeded timeline.
    const big = await timeline(win, { scope: 'project', limit: 200 });
    expect(big.nextCursor, 'the seeded Brain fits in one page of 200').toBeNull();
    expect(big.entries.length).toBeGreaterThanOrEqual(10);
    expectNewestFirst(big.entries);
    for (const e of big.entries) {
      expect(e.what.trim(), `"what" for ${e.title}`).toMatch(/\p{L}{2,}/u);
      expect(e.title.length).toBeGreaterThan(0);
      if (e.currentTitle !== null) expect(e.currentTitle).not.toBe(e.title);
      expect(e.actorType).toBe(e.changedBy === 'user' ? 'user' : 'agent');
    }
    expect(new Set(big.entries.map(keyOf)).size, 'no entry twice').toBe(big.entries.length);
    expect(big.actors).toContain('Ant-seed');

    // Pages of 5: the same entries in the same order, no duplicates and no gaps.
    const walked = await walkAll(win, { scope: 'project' }, 5);
    expect(walked.pages).toBeGreaterThan(1);
    expect(walked.entries.map(keyOf)).toEqual(big.entries.map(keyOf));

    // Only creations.
    const creates = await timeline(win, { scope: 'project', changes: ['create'], limit: 200 });
    expect(creates.entries.length).toBeGreaterThan(0);
    for (const e of creates.entries) expect(e.change).toBe('create');
    expect(creates.entries.length).toBe(big.entries.filter((e) => e.change === 'create').length);

    // Only facts.
    const facts = await timeline(win, { scope: 'project', kinds: ['fact'], limit: 200 });
    expect(facts.entries.length).toBeGreaterThan(0);
    for (const e of facts.entries) expect(e.kind).toBe('fact');

    // By title.
    const hosting = await timeline(win, { scope: 'project', query: 'Hosting provider', limit: 200 });
    expect(hosting.entries.length).toBeGreaterThanOrEqual(2);
    for (const e of hosting.entries) expect(`${e.title} ${e.currentTitle ?? ''}`.toLowerCase()).toContain('hosting');
    expect(hosting.entries.some((e) => e.title === 'Take payments by card only')).toBe(false);

    // The replaced "Hosting provider" (Netlify) fact: a "Replaced by …" entry.
    const replaced = big.entries.filter((e) => e.change === 'supersede');
    expect(replaced.length).toBeGreaterThanOrEqual(1);
    const hostingReplaced = replaced.find((e) => e.title === 'Hosting provider');
    expect(hostingReplaced, 'the seeded Hosting provider fact was replaced').toBeDefined();
    expect(hostingReplaced!.what).toMatch(/^Replaced by\b/);
    expect(hostingReplaced!.kind).toBe('fact');

    // The user edits (and renames) a record: actor 'user' shows only the user's changes, that one included.
    const id = await idOf(win, 'Order page progress');
    const rec = await win.evaluate((i) => (globalThis as unknown as AppWindow).insectoids.hive.brainRecord(i), id);
    expect(rec).not.toBeNull();
    const saved = await win.evaluate(
      (req) => (globalThis as unknown as AppWindow).insectoids.hive.brainEdit(req),
      { id, baseVersion: rec!.version, title: 'Order page progress, totals done', body: 'The order summary page shows totals now; delivery dates come next.', summary: rec!.summary },
    );
    expect(saved.status).toBe('saved');

    const mine = await timeline(win, { scope: 'project', actor: 'user', limit: 200 });
    expect(mine.entries.length).toBeGreaterThan(0);
    for (const e of mine.entries) {
      expect(e.changedBy).toBe('user');
      expect(e.actorType).toBe('user');
    }
    const edit = mine.entries.find((e) => e.recordId === id && e.change === 'update');
    expect(edit, 'the user edit is in the user-only timeline').toBeDefined();
    expect(edit!.what).toBe('Edited');
    expect(edit!.title).toBe('Order page progress, totals done');
    expect(mine.actors[0]).toBe('user');

    // The edit is now the newest change, and older entries of that record keep their old title.
    const after = await timeline(win, { scope: 'project', limit: 200 });
    expect(keyOf(after.entries[0]!)).toBe(keyOf(edit!));
    const created = after.entries.find((e) => e.recordId === id && e.change === 'create');
    expect(created?.title).toBe('Order page progress');
    expect(created?.currentTitle).toBe('Order page progress, totals done');

    // Agents only: none of the user's.
    const agents = await timeline(win, { scope: 'project', actor: 'agents', limit: 200 });
    expect(agents.entries.length).toBeGreaterThan(0);
    for (const e of agents.entries) expect(e.actorType).toBe('agent');
    expect(agents.entries.length + mine.entries.length).toBe(after.entries.length);
  });

  test('an agent edit appears as "Edited" by that agent', async () => {
    const { win } = t;
    const id = await idOf(win, 'Take payments by card only');
    await t.app.evaluate(
      async (_electron, [recordId, text]) => {
        const hook = (globalThis as unknown as { __insectoidsE2E: { agentEditRecord: (i: string, b: string) => Promise<void> } }).__insectoidsE2E;
        await hook.agentEditRecord(recordId, text);
      },
      [id, 'Cards and PayPal at launch; still no bank transfers.'] as const,
    );
    const rec = await win.evaluate((i) => (globalThis as unknown as AppWindow).insectoids.hive.brainRecord(i), id);

    const all = await timeline(win, { scope: 'project', limit: 200 });
    const top = all.entries[0]!;
    expect(top.recordId).toBe(id);
    expect(top.version).toBe(rec!.version);
    expect(top.change).toBe('update');
    expect(top.changedBy).toBe('e2e-agent');
    expect(top.actorType).toBe('agent');
    expect(top.what).toBe('Edited');
    expect(top.title).toBe('Take payments by card only');
    expect(all.actors).toContain('e2e-agent');

    // That agent alone: only its changes.
    const its = await timeline(win, { scope: 'project', actor: 'e2e-agent', limit: 200 });
    expect(its.entries.map(keyOf)).toEqual([keyOf(top)]);
    // And not in the user's.
    const mine = await timeline(win, { scope: 'project', actor: 'user', limit: 200 });
    expect(mine.entries.some((e) => e.recordId === id && e.version === top.version)).toBe(false);
  });
});

// ---- the screen, on a bigger Brain ---------------------------------------------------------------

test.describe('the Timeline view', () => {
  test.describe.configure({ mode: 'serial' });

  let t: LaunchedApp;
  let errors: string[];
  const SEEDED = 120;

  const view = (win: Page): Locator => win.getByTestId('brain-timeline');
  const rows = (win: Page): Locator => view(win).getByTestId('timeline-entry');
  const rowInfo = (win: Page): Promise<{ change: string; id: string }[]> =>
    rows(win).evaluateAll((els) => els.map((e) => ({ change: e.getAttribute('data-change') ?? '', id: e.getAttribute('data-record-id') ?? '' })));
  // the change chips are toggle buttons (aria-pressed) on the Timeline view, named by the change.
  const chip = (win: Page, name: string): Locator => view(win).getByRole('button', { name, exact: true });
  // the "Who changed it" select (a native <select> with that label).
  const who = (win: Page): Locator => win.getByLabel('Who changed it');
  // the "Filter by title" search box (its label or its placeholder).
  const titleFilter = (win: Page): Locator => win.getByRole('searchbox', { name: 'Filter by title' }).or(win.getByPlaceholder('Filter by title')).first();
  const more = (win: Page): Locator => win.getByTestId('timeline-more');

  async function openView(win: Page, name: string): Promise<void> {
    const tabs = win.getByRole('tablist', { name: 'Brain view' });
    if (!(await tabs.isVisible())) await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Brain' }).click();
    // the Timeline is a tab named "Timeline" in the "Brain view" tablist.
    await tabs.getByRole('tab', { name, exact: true }).click();
    await expect(tabs.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
  }

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    t = await launchApp({ env: { INSECTOIDS_E2E_BRAIN_SEED: '1' } });
    errors = watchErrors(t.win);
    await waitForSeed(t.win);
    const seeded = await t.app.evaluate(async (_electron, count) => {
      const hook = (
        globalThis as unknown as {
          __insectoidsE2E: { seedRecords: (count: number, linksPerRecord: number) => Promise<{ created: number; links: number; total: number; ms: number }> };
        }
      ).__insectoidsE2E;
      return hook.seedRecords(count, 0);
    }, SEEDED);
    expect(seeded.created).toBe(SEEDED);
    await openView(t.win, 'Timeline');
    await expect(rows(t.win).first()).toBeVisible({ timeout: 10_000 });
  });

  test.afterEach(() => {
    const seen = errors?.splice(0) ?? [];
    expect(seen, 'no console errors or page errors during the test').toEqual([]);
  });

  test.afterAll(async () => {
    await t?.close();
  });

  test('shows the changes newest first, grouped by day', async () => {
    const { win } = t;
    await expect(view(win)).toBeVisible();
    // Everything here changed today: a day heading says "Today".
    await expect(view(win).getByText('Today', { exact: true }).first()).toBeVisible();
    // The first rows are the newest API entries (the last seeded records), in the same order.
    const api = await timeline(win, { scope: 'project', limit: 5 });
    const shown = (await rowInfo(win)).slice(0, 5);
    expect(shown.map((r) => r.id)).toEqual(api.entries.map((e) => e.recordId));
    expect(shown.map((r) => r.change)).toEqual(api.entries.map((e) => e.change));
    await expect(rows(win).first()).toContainText(api.entries[0]!.title);
  });

  test('the change chips and "Who changed it" narrow the list', async () => {
    const { win } = t;

    // "Replaced": only replacements, the Hosting provider fact among them.
    await chip(win, 'Replaced').click();
    await expect(chip(win, 'Replaced')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await rowInfo(win)).map((r) => r.change), { timeout: 10_000 }).toEqual(
      (await timeline(win, { scope: 'project', changes: ['supersede'], limit: 200 })).entries.map(() => 'supersede'),
    );
    await expect(view(win)).toContainText('Hosting provider');
    await chip(win, 'Replaced').click();
    await expect(chip(win, 'Replaced')).toHaveAttribute('aria-pressed', 'false');

    // "Created": only creations.
    await chip(win, 'Created').click();
    await expect.poll(async () => {
      const r = await rowInfo(win);
      return r.length > 0 && r.every((x) => x.change === 'create');
    }, { timeout: 10_000 }).toBe(true);
    await chip(win, 'Created').click();
    await expect(chip(win, 'Created')).toHaveAttribute('aria-pressed', 'false');
    // Unfiltered again: the first page matches the API's (here all creations: 120 records were just seeded).
    const firstPage = (await timeline(win, { scope: 'project', limit: 50 })).entries.map((e) => e.recordId);
    await expect
      .poll(async () => (await rowInfo(win)).slice(0, firstPage.length).map((r) => r.id), { timeout: 10_000 })
      .toEqual(firstPage);

    // Who: one agent, then the user, then everyone again. Each row must be one of that person's changes.
    const options = await who(win).locator('option').allTextContents();
    expect(options).toEqual(expect.arrayContaining(['Everyone', 'You', 'All agents', 'Ant-seed']));
    for (const [label, actor] of [['Ant-seed', 'Ant-seed'], ['You', 'user'], ['All agents', 'agents']] as const) {
      await who(win).selectOption({ label });
      const theirs = new Set((await walkAll(win, { scope: 'all', actor }, 200)).entries.map((e) => `${e.recordId}:${e.change}`));
      await expect.poll(async () => {
        const r = await rowInfo(win);
        return r.length > 0 && r.every((x) => theirs.has(`${x.id}:${x.change}`));
      }, { message: `only ${label}'s changes`, timeout: 10_000 }).toBe(true);
    }
    // Everyone again: the newest change on the shelf is back at the top.
    await who(win).selectOption({ label: 'Everyone' });
    const newest = (await timeline(win, { scope: 'project', limit: 1 })).entries[0]!;
    await expect.poll(async () => (await rowInfo(win))[0]?.id, { timeout: 10_000 }).toBe(newest.recordId);

    // By title, and the empty state.
    await titleFilter(win).fill('Hosting provider');
    await expect.poll(async () => {
      const texts = await rows(win).allTextContents();
      return texts.length > 0 && texts.every((x) => x.includes('Hosting provider'));
    }, { timeout: 10_000 }).toBe(true);
    await titleFilter(win).fill('zzz nothing has this title qqq');
    await expect(view(win).getByText('Nothing changed in this range.')).toBeVisible({ timeout: 10_000 });
    await expect(rows(win)).toHaveCount(0);
    await titleFilter(win).fill('');
    await expect(rows(win).first()).toBeVisible({ timeout: 10_000 });
  });

  test('clicking a title opens the record in the reader', async () => {
    const { win } = t;
    const title = 'Order page progress';
    await titleFilter(win).fill(title);
    const row = rows(win).filter({ hasText: title }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    // The title in the row is a button that opens the record.
    await row.getByTestId('timeline-open').click();
    await expect(win.getByTestId('brain-reader').getByRole('heading', { name: title })).toBeVisible({ timeout: 10_000 });
    await titleFilter(win).fill('');
    // The reader may have taken over the view; come back to the Timeline.
    if (!(await view(win).isVisible())) await openView(win, 'Timeline');
    await expect(rows(win).first()).toBeVisible({ timeout: 10_000 });
  });

  test('"Show older" loads more pages until "That\'s everything."', async () => {
    test.setTimeout(45_000);
    const { win } = t;
    // the view's default scope is the open project's shelf (plus Global), like the graph's default.
    const total = (await walkAll(win, { scope: 'project' }, 200)).entries.length;
    expect(total).toBeGreaterThan(SEEDED);

    await expect(more(win)).toBeVisible({ timeout: 10_000 });
    await expect(view(win).getByTestId('timeline-end')).toHaveCount(0);
    const firstPage = await rows(win).count();
    expect(firstPage).toBeGreaterThan(0);
    expect(firstPage).toBeLessThan(total);

    for (let i = 0; i < 20 && (await more(win).isVisible()); i++) {
      const before = await rows(win).count();
      await more(win).click();
      await expect.poll(async () => rows(win).count(), { timeout: 10_000 }).toBeGreaterThan(before);
    }
    await expect(more(win)).toHaveCount(0);
    await expect(view(win).getByTestId('timeline-end')).toHaveText("That's everything.");
    await expect(rows(win)).toHaveCount(total);
    // No row twice across the pages.
    const keys = await rows(win).evaluateAll((els) => els.map((e) => `${e.getAttribute('data-record-id')}:${e.getAttribute('data-change')}:${e.textContent}`));
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('the Dashboard\'s "See the full timeline" opens the Timeline view', async () => {
    const { win } = t;
    await openView(win, 'Dashboard');
    const dash = win.getByTestId('brain-dashboard');
    await expect(dash).toBeVisible({ timeout: 10_000 });
    // a link (or a link-styled button) named "See the full timeline" on the Dashboard.
    const link = dash.getByRole('link', { name: 'See the full timeline' }).or(dash.getByRole('button', { name: 'See the full timeline' })).first();
    await link.click();
    await expect(win.getByRole('tablist', { name: 'Brain view' }).getByRole('tab', { name: 'Timeline', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(view(win)).toBeVisible();
    await expect(rows(win).first()).toBeVisible({ timeout: 10_000 });
  });
});
