import { type ConsoleMessage, type Locator, type Page, expect, test } from '@playwright/test';
import type { BrainGraphRequest, BrainGraphView } from '@insectoids/shared';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * The Brain Globe (Phase 4 A2): the Brain's records as points on a turning 3D globe (Three.js), next to the 2D graph.
 * Same data as the graph (`hive.brainGraph` with a `limit` up to 5,000), the same filters, and an accessible list
 * beside it: one button per record, which opens it in the reader and selects it on the globe.
 *
 * What the Globe exposes for tests, on `data-testid="brain-globe"`:
 * - `data-ready="true"` once the first frame is drawn;
 * - `data-nodes` / `data-edges`: how many points and lines are drawn;
 * - `data-selected`: the selected record's id;
 * - `data-frame-ms`: the average frame time over the last 60 frames.
 *
 * Two apps: the small seeded Brain (INSECTOIDS_E2E_BRAIN_SEED: a linked decision/task/fact/update cluster and a few
 * more) for what the Globe shows and how it behaves, and a big Brain (5,000 records, ~1.5 links each, written by the
 * e2e-only `seedRecords` hook) for speed. Any console error or uncaught page error fails the test it happened in.
 */

// ---- helpers -------------------------------------------------------------------------------------

const GLOBE_LIMIT = 5000;

/** What the graph API returns for the Globe's filters (the Globe asks for up to 5,000). */
const apiGraph = (win: Page, req: BrainGraphRequest): Promise<BrainGraphView> =>
  win.evaluate((r) => (globalThis as unknown as AppWindow).insectoids.hive.brainGraph(r), { limit: GLOBE_LIMIT, ...req });

const globe = (win: Page): Locator => win.getByTestId('brain-globe');
const globeList = (win: Page): Locator => win.getByTestId('globe-list');
const numberAttr = async (loc: Locator, name: string): Promise<number> => Number(await loc.getAttribute(name));

/** Collects console errors and uncaught page errors; each test checks it added none. */
function watchErrors(win: Page): string[] {
  const errors: string[] = [];
  win.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  win.on('pageerror', (e: Error) => errors.push(`page error: ${e.message}`));
  return errors;
}

/** The Brain screen, then a view tab ("Notes", "Graph", "Dashboard", "Code", "Globe"). */
async function openView(win: Page, view: string): Promise<void> {
  const nav = win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Brain' });
  const tabs = win.getByRole('tablist', { name: 'Brain view' });
  if (!(await tabs.isVisible())) await nav.click();
  // UI-SELECTOR: the Globe is a tab named "Globe" in the "Brain view" tablist, next to "Graph".
  await tabs.getByRole('tab', { name: view, exact: true }).click();
  await expect(tabs.getByRole('tab', { name: view, exact: true })).toHaveAttribute('aria-selected', 'true');
}

async function expectGlobeReady(win: Page, timeout = 15_000): Promise<void> {
  await expect(globe(win)).toBeVisible({ timeout });
  await expect(globe(win)).toHaveAttribute('data-ready', 'true', { timeout });
}

/** The Globe draws exactly what the API returns for `req` (polled: a filter change reloads and redraws). */
async function expectGlobeMatches(win: Page, req: BrainGraphRequest, timeout = 15_000): Promise<BrainGraphView> {
  const g = await apiGraph(win, req);
  await expect.poll(async () => numberAttr(globe(win), 'data-nodes'), { timeout }).toBe(g.nodes.length);
  await expectGlobeReady(win, timeout);
  return g;
}

/** UI-SELECTOR: the theme toggle in the top bar (the same one accessibility.spec.ts uses). */
async function setTheme(win: Page, theme: 'dark' | 'light'): Promise<void> {
  const toggle = win.getByRole('button', { name: /^Switch to (dark|light) theme$/ });
  if ((await toggle.getAttribute('aria-label')) === `Switch to ${theme} theme`) await toggle.click();
  await expect(win.locator('html')).toHaveAttribute('data-theme', theme);
}

/** "showing N of M": N drawn, M matched the filters (N plus what the limit left out). */
// UI-SELECTOR: the count line is found by its words anywhere on the Brain screen (only the Globe view is showing).
const showingLine = (win: Page): Locator => win.getByText(/showing\s+[\d,]+\s+of\s+[\d,]+/i).first();
const showing = (n: number, m: number): RegExp => new RegExp(`showing\\s+${n.toLocaleString('en-US').replace(/,/g, ',?')}\\s+of\\s+${m.toLocaleString('en-US').replace(/,/g, ',?')}`, 'i');

// ---- the seeded Brain ----------------------------------------------------------------------------

test.describe('the Globe on the seeded Brain', () => {
  test.describe.configure({ mode: 'serial' });

  let t: LaunchedApp;
  let errors: string[];

  test.beforeAll(async () => {
    t = await launchApp({ env: { INSECTOIDS_E2E_BRAIN_SEED: '1' } });
    errors = watchErrors(t.win);
    await expect(t.win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
    // The seed is written when the project opens; wait until the graph API has its linked cluster.
    await expect
      .poll(async () => (await apiGraph(t.win, { scope: 'project' })).nodes.some((n) => n.title === 'Take payments by card only'), { timeout: 15_000 })
      .toBe(true);
    await openView(t.win, 'Globe');
  });

  test.afterEach(() => {
    const seen = errors?.splice(0) ?? [];
    expect(seen, 'no console errors or page errors during the test').toEqual([]);
  });

  test.afterAll(async () => {
    await t?.close();
  });

  test('renders the same records and links as the graph API, with a "showing N of M" line', async () => {
    const { win } = t;
    await expectGlobeReady(win);
    const g = await expectGlobeMatches(win, { scope: 'project' });
    expect(g.nodes.length).toBeGreaterThanOrEqual(4);
    const edges = await numberAttr(globe(win), 'data-edges');
    expect(edges).toBeGreaterThan(0);
    expect(edges).toBeLessThanOrEqual(g.edges.length);
    await expect(showingLine(win)).toHaveText(showing(g.nodes.length, g.nodes.length + g.hidden));
  });

  test('the list beside it has one button per record drawn, the same records', async () => {
    const { win } = t;
    const g = await expectGlobeMatches(win, { scope: 'project' });
    // UI-SELECTOR: one button per record inside the list (whatever wraps it: ul/li or a plain container).
    const buttons = globeList(win).getByRole('button');
    await expect(buttons).toHaveCount(g.nodes.length);
    for (const n of g.nodes) await expect(globeList(win)).toContainText(n.title);
  });

  test('a list item opens the record in the reader and selects it on the globe', async () => {
    const { win } = t;
    const g = await apiGraph(win, { scope: 'project' });
    const reader = win.getByTestId('brain-reader');
    for (const title of ['Take payments by card only', 'Build the order summary page']) {
      const node = g.nodes.find((n) => n.title === title);
      expect(node, `the seeded "${title}"`).toBeDefined();
      await globeList(win).getByRole('button', { name: title }).click();
      await expect(reader.getByRole('heading', { name: title })).toBeVisible({ timeout: 10_000 });
      await expect(globe(win)).toHaveAttribute('data-selected', node!.id);
    }
    // The globe keeps drawing with a record selected and the reader open.
    await expectGlobeReady(win);
  });

  test('a kind filter (shared with the graph) narrows what is drawn and listed; clearing it brings the rest back', async () => {
    const { win } = t;
    const all = await expectGlobeMatches(win, { scope: 'project' });
    // UI-SELECTOR: the same "Filter by kind" chip group as the 2D graph (only one is on screen in the Globe view).
    const chip = win.getByRole('group', { name: 'Filter by kind' }).getByRole('button', { name: 'Decision' });
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    const decisions = await expectGlobeMatches(win, { scope: 'project', kinds: ['decision'] });
    expect(decisions.nodes.length).toBeGreaterThan(0);
    expect(decisions.nodes.length).toBeLessThan(all.nodes.length);
    expect(await numberAttr(globe(win), 'data-edges')).toBeLessThanOrEqual(decisions.edges.length);
    await expect(globeList(win).getByRole('button')).toHaveCount(decisions.nodes.length);
    await expect(globeList(win)).toContainText('Take payments by card only');
    await expect(globeList(win)).not.toContainText('Build the order summary page');
    await expect(showingLine(win)).toHaveText(showing(decisions.nodes.length, decisions.nodes.length + decisions.hidden));

    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await expectGlobeMatches(win, { scope: 'project' });
  });

  test('the scope filter: Global alone, then All shelves, each matching the API', async () => {
    const { win } = t;
    // UI-SELECTOR: the same "Which shelf" group as the 2D graph ("This project", "Global", "All").
    const shelf = win.getByRole('group', { name: 'Which shelf' });
    await shelf.getByRole('button', { name: 'All', exact: true }).click();
    await expectGlobeMatches(win, { scope: 'all' });
    await shelf.getByRole('button', { name: 'Global', exact: true }).click();
    const global = await apiGraph(win, { scope: 'global' });
    if (global.nodes.length > 0) {
      await expectGlobeMatches(win, { scope: 'global' });
    } else {
      // An empty Globe may show an empty state instead of a canvas; the count line still says so.
      await expect(showingLine(win)).toHaveText(showing(0, 0));
    }
    await shelf.getByRole('button', { name: 'This project', exact: true }).click();
    await expectGlobeMatches(win, { scope: 'project' });
  });

  test('draws in both the dark and the light theme', async () => {
    const info = test.info();
    const { win } = t;
    const shots: Buffer[] = [];
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(win, theme);
      await expectGlobeMatches(win, { scope: 'project' });
      const canvas = globe(win).locator('canvas').first();
      await expect(canvas).toBeVisible();
      const box = await canvas.boundingBox();
      expect(box && box.width > 50 && box.height > 50, `the ${theme} canvas has a real size`).toBe(true);
      // Two frames later, still drawing (the theme change did not stop or lose the WebGL context).
      await win.waitForTimeout(300);
      await expect(globe(win)).toHaveAttribute('data-ready', 'true');
      const shot = await globe(win).screenshot();
      shots.push(shot);
      await info.attach(`globe-${theme}.png`, { body: shot, contentType: 'image/png' });
    }
    // The theme reaches the globe (its backdrop and colours differ), so the two pictures are not the same.
    expect(shots[0]!.equals(shots[1]!)).toBe(false);
    await setTheme(win, 'dark');
  });

  test('clicking on the canvas, on a point or on empty space, crashes nothing', async () => {
    const { win } = t;
    await expectGlobeReady(win);
    const canvas = globe(win).locator('canvas').first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    // The centre (most likely the globe itself), then a corner (most likely empty space). Finding a point's screen
    // position from outside is not worth it: the list covers opening a record.
    await canvas.click({ position: { x: box!.width / 2, y: box!.height / 2 } });
    await canvas.click({ position: { x: 6, y: 6 } });
    // A small drag (a turn of the globe, if dragging turns it) and a wheel step (a zoom, if the wheel zooms).
    await win.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await win.mouse.down();
    await win.mouse.move(box!.x + box!.width / 2 + 60, box!.y + box!.height / 2 + 20, { steps: 5 });
    await win.mouse.up();
    await win.mouse.wheel(0, -200);
    await win.waitForTimeout(500);
    await expect(globe(win)).toHaveAttribute('data-ready', 'true');
    expect(await numberAttr(globe(win), 'data-nodes')).toBe((await apiGraph(win, { scope: 'project' })).nodes.length);
  });

  test('switching to other views and back, twice, leaves one working globe (no leaked canvases)', async () => {
    const { win } = t;
    await expectGlobeReady(win);
    const nodes = await numberAttr(globe(win), 'data-nodes');
    const canvases = (): Promise<number> => win.locator('canvas').count();
    const before = await canvases();
    expect(await globe(win).locator('canvas').count()).toBe(1);
    for (const away of ['Graph', 'Notes']) {
      await openView(win, away);
      await expect(globe(win)).toHaveCount(0);
      if (away === 'Graph') await expect(win.getByTestId('brain-graph')).toBeVisible();
      // The Globe's canvas went with it.
      expect(await canvases()).toBeLessThan(before);
      await openView(win, 'Globe');
      await expectGlobeReady(win);
      expect(await numberAttr(globe(win), 'data-nodes')).toBe(nodes);
      expect(await globe(win).locator('canvas').count()).toBe(1);
      expect(await canvases()).toBe(before);
    }
    // And away to another screen entirely, then back.
    await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Hive' }).click();
    await expect(globe(win)).toHaveCount(0);
    await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Brain' }).click();
    // The Brain screen may open on its first view again; open the Globe if it is not already showing.
    if (!(await globe(win).isVisible())) await openView(win, 'Globe');
    await expectGlobeReady(win);
    expect(await numberAttr(globe(win), 'data-nodes')).toBe(nodes);
  });
});

// ---- a big Brain ---------------------------------------------------------------------------------

/**
 * Frame time at idle spin. The goal is ≈30 fps (under 34 ms a frame) on a normal PC with a GPU. CI runners and
 * machines without a usable GPU draw WebGL in software (SwiftShader), where 5,000 points can honestly run slower;
 * failing there would say nothing about the Globe. So the hard limit is generous (100 ms, ≈10 fps: anything slower
 * means something is really wrong, like re-laying-out every frame), the number is always written to the test output
 * and the report, and INSECTOIDS_E2E_STRICT_FPS=1 makes the 34 ms goal the limit (for runs on a real GPU).
 */
const FRAME_GOAL_MS = 34;
const FRAME_LIMIT_MS = process.env['INSECTOIDS_E2E_STRICT_FPS'] === '1' ? FRAME_GOAL_MS : 100;

test.describe('the Globe on a big Brain (5,000 records)', () => {
  test.describe.configure({ mode: 'serial' });

  let t: LaunchedApp;
  let errors: string[];

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    t = await launchApp();
    errors = watchErrors(t.win);
    await expect(t.win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
    // 5,000 records, ~1.5 `relates_to` links each, on the project's shelf. The hook (main process only) sends them
    // to the Brain host in chunks, so the window's own calls keep being answered meanwhile (~8 s on a dev PC).
    const seeded = await t.app.evaluate(async () => {
      const hook = (
        globalThis as unknown as {
          __insectoidsE2E: { seedRecords: (count: number, linksPerRecord: number) => Promise<{ created: number; links: number; total: number; ms: number }> };
        }
      ).__insectoidsE2E;
      return hook.seedRecords(5000, 1.5);
    });
    expect(seeded.created).toBe(5000);
    expect(seeded.links).toBeGreaterThan(5000);
    console.log(`[globe] seeded ${seeded.created} records and ${seeded.links} links in ${seeded.ms} ms`);
  });

  test.afterEach(() => {
    const seen = errors?.splice(0) ?? [];
    expect(seen, 'no console errors or page errors during the test').toEqual([]);
  });

  test.afterAll(async () => {
    await t?.close();
  });

  test('draws all 5,000 within 15 s, and spins at a usable frame rate', async () => {
    const info = test.info();
    test.setTimeout(120_000);
    const { win } = t;
    const started = Date.now();
    await openView(win, 'Globe');
    // UI-SELECTOR: the same "Which shelf" group as the 2D graph.
    await win.getByRole('group', { name: 'Which shelf' }).getByRole('button', { name: 'All', exact: true }).click();
    const g = await apiGraph(win, { scope: 'all' });
    expect(g.nodes.length).toBe(GLOBE_LIMIT);
    await expect.poll(async () => numberAttr(globe(win), 'data-nodes'), { timeout: 15_000 }).toBe(g.nodes.length);
    await expectGlobeReady(win, 15_000);
    const readyMs = Date.now() - started;
    expect(readyMs).toBeLessThan(15_000);
    expect(await numberAttr(globe(win), 'data-edges')).toBeGreaterThan(0);
    await expect(showingLine(win)).toHaveText(showing(g.nodes.length, g.nodes.length + g.hidden));

    // A few seconds of idle spin, then the average time spent drawing one frame (last 60 drawn). The window is
    // brought to the front first: Chromium sends no animation frames to a window hidden behind others.
    await t.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w?.show();
      w?.focus();
    });
    await win.waitForTimeout(4_000);
    await expect.poll(async () => numberAttr(globe(win), 'data-frame-ms'), { timeout: 10_000 }).toBeGreaterThan(0);
    const frameMs = await numberAttr(globe(win), 'data-frame-ms');
    const note = `${g.nodes.length} nodes, ${await numberAttr(globe(win), 'data-edges')} edges: ready in ${readyMs} ms, ${frameMs.toFixed(1)} ms of drawing work a frame on the CPU side (goal under ${FRAME_GOAL_MS} ms)`;
    console.log(`[globe] ${note}`);
    info.annotations.push({ type: 'globe-performance', description: note });
    if (frameMs >= FRAME_GOAL_MS) {
      info.annotations.push({ type: 'warning', description: `Over the ${FRAME_GOAL_MS} ms goal (a software renderer or a slow GPU?): ${frameMs.toFixed(1)} ms a frame.` });
    }
    expect(Number.isFinite(frameMs)).toBe(true);
    expect(frameMs, `average frame time (limit ${FRAME_LIMIT_MS} ms)`).toBeLessThan(FRAME_LIMIT_MS);
  });

  test('the list and the selection still work with 5,000 records', async () => {
    const { win } = t;
    await expectGlobeReady(win);
    // UI-SELECTOR: the list may be virtualised (only some of the 5,000 buttons in the DOM); use the first one shown.
    const seedTitle = /Seed (?:fact|decision|task|update|note) \d+/;
    const first = globeList(win).getByRole('button', { name: seedTitle }).first();
    await first.scrollIntoViewIfNeeded();
    const title = seedTitle.exec((await first.textContent()) ?? '')?.[0];
    expect(title, 'a seeded record in the list').toBeDefined();
    await first.click();
    await expect(win.getByTestId('brain-reader').getByRole('heading', { name: title!, exact: true })).toBeVisible({ timeout: 10_000 });
    const g = await apiGraph(win, { scope: 'all' });
    const id = g.nodes.find((n) => n.title === title)?.id;
    expect(id, `"${title}" is in the graph`).toBeDefined();
    await expect(globe(win)).toHaveAttribute('data-selected', id!);
  });

  test('switching away and back twice with 5,000 records: no errors, still draws them all', async () => {
    const { win } = t;
    const nodes = await numberAttr(globe(win), 'data-nodes');
    for (let i = 0; i < 2; i++) {
      await openView(win, 'Graph');
      await expect(globe(win)).toHaveCount(0);
      await openView(win, 'Globe');
      await expectGlobeReady(win, 15_000);
      // The scope may or may not be remembered across a switch; either way the drawn count matches the API.
      const scopeAll = await win.getByRole('group', { name: 'Which shelf' }).getByRole('button', { name: 'All', exact: true }).getAttribute('aria-pressed');
      if (scopeAll === 'true') {
        await expect.poll(async () => numberAttr(globe(win), 'data-nodes'), { timeout: 15_000 }).toBe(nodes);
      } else {
        await expectGlobeMatches(win, { scope: 'project' });
      }
      expect(await globe(win).locator('canvas').count()).toBe(1);
    }
  });
});
