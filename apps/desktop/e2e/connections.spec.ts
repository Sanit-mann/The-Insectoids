import { expect, test } from '@playwright/test';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp();
  const { win } = launched;
  await expect(win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Connections' }).click();
});

test.afterAll(async () => {
  await launched?.close();
});

const engineOrder = (l: LaunchedApp): Promise<string[]> =>
  l.win.evaluate(async () => (await (globalThis as unknown as AppWindow).insectoids.hive.snapshot()).engines.map((e) => e.id));

test('the Engines tab lists every engine in order, with the default marked', async () => {
  const { win } = launched;
  await expect(win.getByRole('tab', { name: 'Engines' })).toHaveAttribute('aria-selected', 'true');
  const list = win.getByTestId('engine-list');
  await expect(list).toBeVisible();

  const order = await engineOrder(launched);
  const cards = list.locator('[data-engine]');
  await expect(cards).toHaveCount(order.length);
  expect(await cards.evaluateAll((els) => els.map((el) => el.getAttribute('data-engine')))).toEqual(order);

  // The scripted test engine is ready, so it is the default.
  await expect(win.getByTestId('engine-fake').getByTestId('default-badge')).toBeVisible();
  await expect(win.getByTestId('default-badge')).toHaveCount(1);

  // Every engine shows its state as words, not only a colour.
  for (const id of ['claude', 'gemini', 'codex', 'opencode']) {
    const state = win.getByTestId(`engine-${id}-state`);
    await expect(state).toBeVisible();
    await expect(state).not.toHaveText('');
  }
});

test('a command can be copied', async () => {
  const { win, app } = launched;
  const copy = win.getByRole('button', { name: /^Copy: / }).first();
  await expect(copy).toBeVisible();
  const command = (await copy.getAttribute('aria-label'))!.replace(/^Copy: /, '');
  await copy.click();
  await expect(copy).toContainText('Copied');
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(command);
});

test('an engine can be switched off and on again', async () => {
  const { win } = launched;
  const toggle = win.getByRole('switch', { name: 'Use Claude Code for hive work' });
  await expect(toggle).toBeEnabled();
  const before = await toggle.getAttribute('aria-checked');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', before ?? 'true');
});

test('moving an engine down changes the order', async () => {
  const { win } = launched;
  const before = await engineOrder(launched);
  const first = before[0]!;
  const name = (await win.getByTestId(`engine-${first}`).locator('h3').textContent())!;
  await win.getByRole('button', { name: `Move ${name} down` }).click();
  await expect.poll(() => engineOrder(launched)).toEqual([before[1], first, ...before.slice(2)]);
  await expect(win.getByTestId('engine-list').locator('[data-engine]').nth(1)).toHaveAttribute('data-engine', first);
  // And back, leaving the order as it was for other tests.
  await win.getByRole('button', { name: `Move ${name} up` }).click();
  await expect.poll(() => engineOrder(launched)).toEqual(before);
});

test('tabs for later steps say so', async () => {
  const { win } = launched;
  for (const [label, id] of [
    ['API providers', 'providers'],
    ['Services', 'services'],
    ['Vault', 'vault'],
  ] as const) {
    await win.getByRole('tab', { name: new RegExp(`^${label}`) }).click();
    await expect(win.getByTestId(`later-${id}`)).toContainText('Later');
  }
  await win.getByRole('tab', { name: 'Engines' }).click();
  await expect(win.getByTestId('engine-list')).toBeVisible();
});
