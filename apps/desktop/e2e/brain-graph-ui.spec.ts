import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './support/launch';

/**
 * Brain screen, Phase 2 B5: the graph (Memory 01-D10, D13). Records are nodes drawn by kind, lines come
 * only from real links, filters narrow it, the same records read as a list, and a node opens the reader.
 * The seeded Brain (INSECTOIDS_E2E_BRAIN_SEED) has a small linked cluster: a decision, a task that
 * implements it, a fact about it, and an update about the task.
 */
let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ env: { INSECTOIDS_E2E_BRAIN_SEED: '1' } });
  const { win } = launched;
  await expect(win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Brain' }).click();
  await win.getByRole('tablist', { name: 'Brain view' }).getByRole('tab', { name: 'Graph' }).click();
});

test.afterAll(async () => {
  await launched?.close();
});

const graph = () => launched.win.getByTestId('brain-graph');
const nodeTitled = (title: string) => graph().locator(`[data-testid="graph-node"][aria-label*="${title}"]`);

test('the graph shows records as shaped nodes and real links as lines, with a legend', async () => {
  const nodes = graph().getByTestId('graph-node');
  await expect(nodes.first()).toBeVisible({ timeout: 10_000 });
  expect(await nodes.count()).toBeGreaterThanOrEqual(4);
  await expect(nodeTitled('Take payments by card only')).toHaveAttribute('data-kind', 'decision');
  await expect(nodeTitled('Build the order summary page')).toHaveAttribute('data-kind', 'task');
  // Lines only from real links: the seeded ones are there, by meaning.
  await expect(graph().locator('[data-testid="graph-edge"][data-rel="implements"]')).toHaveCount(1);
  expect(await graph().getByTestId('graph-edge').count()).toBeGreaterThanOrEqual(3);
  await expect(graph().getByTestId('graph-count')).toContainText(/\d+ records · \d+ links/);
  const legend = graph().getByTestId('graph-legend');
  await expect(legend).toContainText('Decision');
  await expect(legend).toContainText('Dashed outline');
});

test('a kind filter keeps only that kind, and clearing it brings the rest back', async () => {
  const nodes = graph().getByTestId('graph-node');
  await expect(nodes.first()).toBeVisible({ timeout: 10_000 });
  const before = await nodes.count();
  const chip = graph().getByRole('group', { name: 'Filter by kind' }).getByRole('button', { name: 'Decision' });
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await nodes.evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))).every((k) => k === 'decision'), { timeout: 10_000 }).toBe(true);
  await expect(nodeTitled('Take payments by card only')).toBeVisible();
  expect(await nodes.count()).toBeLessThan(before);
  await chip.click();
  await expect.poll(async () => nodes.count(), { timeout: 10_000 }).toBe(before);
});

test('the same records read as a plain list', async () => {
  const nodes = graph().getByTestId('graph-node');
  await expect(nodes.first()).toBeVisible({ timeout: 10_000 });
  const count = await nodes.count();
  await graph().getByTestId('graph-list-toggle').click();
  const list = graph().getByTestId('graph-list');
  await expect(list).toBeVisible();
  await expect(list.getByTestId('graph-list-item')).toHaveCount(count);
  await expect(list).toContainText('Build the order summary page');
  await graph().getByTestId('graph-list-toggle').click();
  await expect(nodes.first()).toBeVisible();
});

test('clicking a node, or pressing Enter on it, opens the reader', async () => {
  const { win } = launched;
  const decision = nodeTitled('Take payments by card only');
  await expect(decision).toBeVisible({ timeout: 10_000 });
  // Click the shape itself (the node's box also spans its label).
  await decision.locator('path').click();
  const reader = win.getByTestId('brain-reader');
  await expect(reader.getByRole('heading', { name: 'Take payments by card only' })).toBeVisible({ timeout: 10_000 });
  await expect(decision).toHaveAttribute('aria-current', 'true');

  const task = nodeTitled('Build the order summary page');
  await task.focus();
  await win.keyboard.press('Enter');
  await expect(reader.getByRole('heading', { name: 'Build the order summary page' })).toBeVisible({ timeout: 10_000 });
  // Its links in the reader match the lines in the graph.
  await expect(reader.getByText('implements')).toBeVisible();
});

test('the zoom controls change the view and Fit puts it back', async () => {
  const { win } = launched;
  const layer = graph().locator('svg g[transform^="translate"]').first();
  const start = await layer.getAttribute('transform');
  await win.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(async () => layer.getAttribute('transform')).not.toBe(start);
  await graph().getByTestId('graph-fit').click();
  await expect.poll(async () => layer.getAttribute('transform')).toBe(start);
});
