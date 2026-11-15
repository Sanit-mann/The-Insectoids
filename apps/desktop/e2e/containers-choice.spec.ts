import AxeBuilder from '@axe-core/playwright';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { type CardView, type ContainerStatus, DEFAULT_CONTAINER_IMAGE, type HiveApi } from '@insectoids/shared';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * Who chooses containers (Phase 4 D2), with the fake runtime (packages/workspace/src/fake-runtime.mjs) as in
 * containers.spec.ts: nothing here starts a real container or downloads anything.
 *
 * - Settings → Containers is a three-way choice (Off / When needed / Every card) that saves, works from the keyboard
 *   and survives a Brain host restart.
 * - "Run this goal's cards in containers" in the Queen's composer forces containers for that goal, even with the
 *   setting Off: its card shows "In a container", and its runs got `guard.container`. That is seen in the fake
 *   runtime's log: after every run that had a container, the app removes that run's containers by their label
 *   (`ps --filter label=io.insectoids.run=<run name>`), which only happens for runs with one.
 * - The Hive's lanes say "In a container" for the runs that had one.
 * - With no runtime, that goal's card shows "Waiting for containers" and the hive pauses (D1); switching the goal back
 *   to "follow the setting" on its goal view lets it carry on.
 * - The scripted Queen marks a card as risky when the goal says "install": with the setting Off the card shows
 *   "Container suggested" (and runs on the computer); with "When needed" it runs "In a container".
 * Each new piece is scanned with axe in both themes.
 */
const FAKE_RUNTIME = fileURLToPath(new URL('../../../packages/workspace/src/fake-runtime.mjs', import.meta.url));
const THEMES = ['dark', 'light'] as const;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
/** The scripted Queen plans this goal as one wave with one card (no plan approval). */
const GOAL = 'Add a farewell function to the site';
/** Same one-card plan; "install" makes the scripted Queen mark the card as risky. */
const INSTALL_GOAL = 'Add a farewell function to the site and install its packages';
const SWITCH = "Run this goal's cards in containers";
/** The log line of a run's containers being removed by label: only runs that had a container get one. */
const BOXED_RUN = /"label=io\.insectoids\.run=insectoids-[a-z0-9-]+"/;

const status = (win: Page): Promise<ContainerStatus> => win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.containers.status());
const snapshot = (win: Page) => win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.snapshot());
const command = (win: Page, cmd: Parameters<HiveApi['command']>[0]) => win.evaluate((c) => (globalThis as unknown as AppWindow).insectoids.hive.command(c), cmd);
const nav = (win: Page, screen: string): Promise<void> => win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${screen}`) }).click();

/** The one card of a goal once it has its container decision (null = the hive said nothing about containers). */
async function cardOf(win: Page, goalId: string): Promise<CardView | undefined> {
  return (await snapshot(win)).cards.find((c) => c.goalId === goalId);
}
const goalIdOf = async (win: Page, text: string): Promise<string> => {
  let id = '';
  await expect.poll(async () => (id = (await snapshot(win)).goals.find((g) => g.text === text)?.id ?? ''), { timeout: 30_000 }).not.toBe('');
  return id;
};
const waitingMerge = async (win: Page, goalId: string): Promise<string> => {
  let id = '';
  await expect
    .poll(async () => (id = (await snapshot(win)).approvals.find((a) => a.goalId === goalId && a.status === 'waiting' && a.kind === 'merge')?.id ?? ''), { timeout: 60_000 })
    .not.toBe('');
  return id;
};

async function ready(win: Page): Promise<void> {
  await expect(win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(win.getByLabel('Message the Queen')).toBeEnabled({ timeout: 30_000 });
  // The Scout would survey the code first; these goals are about containers, not the Scout.
  expect(await command(win, { type: 'setManagers', scoutBeforePlanning: false })).toEqual({ ok: true });
}

async function openSettings(win: Page): Promise<Locator> {
  await nav(win, 'Settings');
  await expect(win.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible({ timeout: 15_000 });
  await win.getByRole('heading', { level: 2, name: 'Containers' }).scrollIntoViewIfNeeded();
  return win.getByTestId('containers');
}

/** axe on one part of the screen in both themes; serious and critical findings fail. */
async function axe(win: Page, selector: string, state: string): Promise<void> {
  const serious: string[] = [];
  for (const theme of THEMES) {
    await win.evaluate((t) => {
      (globalThis as unknown as { document: { documentElement: { dataset: Record<string, string> } } }).document.documentElement.dataset['theme'] = t;
    }, theme);
    await win.waitForTimeout(300);
    const r = await new AxeBuilder({ page: win }).setLegacyMode(true).include(selector).withTags(TAGS).analyze();
    for (const v of r.violations) {
      if (v.impact === 'serious' || v.impact === 'critical') serious.push(`[${theme}] ${state}: ${v.id} ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
    }
  }
  await win.evaluate(() => {
    (globalThis as unknown as { document: { documentElement: { dataset: Record<string, string> } } }).document.documentElement.dataset['theme'] = 'dark';
  });
  expect(serious, 'serious or critical accessibility findings').toEqual([]);
}

/** The Taskboard showing this goal's card (the goal picked by id when given); returns the card's button. */
async function openCard(win: Page, goalId: string | null): Promise<Locator> {
  await nav(win, 'Taskboard');
  if (goalId) await win.getByRole('combobox', { name: /^Goal/ }).selectOption(goalId);
  const card = win.getByRole('button', { name: /^Add a farewell function\./ });
  await expect(card).toBeVisible({ timeout: 15_000 });
  return card;
}

let t: LaunchedApp | null = null;
let scratch: string;
let log: string;
/** Docker is ready and the image is already on this computer. */
const readyEnv = (): Record<string, string> => ({
  INSECTOIDS_E2E_CONTAINER_RUNTIME: FAKE_RUNTIME,
  INSECTOIDS_E2E_CONTAINER_NODE: process.execPath,
  FAKE_RUNTIME_STATE: join(scratch, 'state.json'),
  FAKE_RUNTIME_LOG: log,
  FAKE_RUNTIME_IMAGES: DEFAULT_CONTAINER_IMAGE,
});
const runtimeLog = (): string => (existsSync(log) ? readFileSync(log, 'utf8') : '');

test.beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'insectoids-e2e-box2-'));
  log = join(scratch, 'runtime.log');
});

test.afterEach(async () => {
  await t?.close();
  t = null;
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
});

test('the setting is a three-way choice that saves, works from the keyboard and survives a Brain host restart', async () => {
  test.setTimeout(120_000);
  t = await launchApp({ env: readyEnv() });
  const { win } = t;
  await win.emulateMedia({ reducedMotion: 'reduce' });
  await expect(win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  const box = await openSettings(win);
  await expect(box).toHaveAttribute('data-runtime', 'ready', { timeout: 30_000 });
  const group = box.getByRole('radiogroup', { name: 'When to use a container' });
  const radio = (name: string): Locator => group.getByRole('radio', { name, exact: true });
  await expect(group.getByRole('radio')).toHaveCount(3);
  await expect(radio('Off')).toHaveAttribute('aria-checked', 'true');
  // Each choice says exactly what it does.
  await expect(radio('Off')).toHaveAccessibleDescription(/Commands run on this computer, guarded as usual\. Only goals you mark/);
  await expect(radio('When needed')).toHaveAccessibleDescription(/cards the Queen marks as risky, cards the Watchdog moves after they got stuck, and goals you mark/);
  await expect(radio('Every card')).toHaveAccessibleDescription("Every card's commands run in a container.");
  await axe(win, '[data-testid="containers"]', 'mode Off');

  await radio('When needed').click();
  await expect(radio('When needed')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await status(win)).settings.mode, { timeout: 15_000 }).toBe('auto');
  // One tab stop (the chosen mode); arrow keys move the choice and save it.
  await expect(radio('When needed')).toHaveAttribute('tabindex', '0');
  await expect(radio('Off')).toHaveAttribute('tabindex', '-1');
  await radio('When needed').focus();
  await win.keyboard.press('ArrowDown');
  await expect(radio('Every card')).toBeFocused();
  await expect.poll(async () => (await status(win)).settings.mode, { timeout: 15_000 }).toBe('always');
  await expect(radio('Every card')).toHaveAttribute('aria-checked', 'true');
  await win.keyboard.press('ArrowUp');
  await expect(radio('When needed')).toBeFocused();
  await expect.poll(async () => (await status(win)).settings.mode, { timeout: 15_000 }).toBe('auto');
  await axe(win, '[data-testid="containers"]', 'mode When needed');

  // Away and back: the choice is read from the host, not kept on screen.
  await nav(win, 'Queen');
  await openSettings(win);
  await expect(radio('When needed')).toHaveAttribute('aria-checked', 'true');

  // The Brain host restarts (as after a crash): the choice is read back from its settings file.
  const pid = await t.app.evaluate(({ app }) => app.getAppMetrics().find((m) => m.serviceName === 'Insectoids Brain' || m.name === 'Insectoids Brain')?.pid ?? null);
  expect(pid).not.toBeNull();
  process.kill(pid!, 'SIGKILL');
  await expect
    .poll(async () => {
      const s = await status(win).catch(() => null);
      return s ? `${s.settings.mode} ${s.runtime.state}` : 'down';
    }, { timeout: 60_000 })
    .toBe('auto ready');
  await nav(win, 'Queen');
  await openSettings(win);
  await expect(radio('When needed')).toHaveAttribute('aria-checked', 'true');
});

test('a goal marked "Run this goal\'s cards in containers" runs its card in one, even with the setting Off', async () => {
  test.setTimeout(150_000);
  t = await launchApp({ env: readyEnv() });
  const { win } = t;
  await win.emulateMedia({ reducedMotion: 'reduce' });
  await ready(win);
  expect((await status(win)).settings.mode).toBe('off');

  // The composer's option; Docker and the image are ready, so there's nothing to warn about.
  const option = win.getByRole('checkbox', { name: SWITCH });
  await option.check();
  await expect(win.getByTestId('goal-containers-note')).toHaveCount(0);
  await win.getByLabel('Message the Queen').fill(GOAL);
  await win.getByLabel('Message the Queen').press('Enter');
  const goalId = await goalIdOf(win, GOAL);
  expect((await snapshot(win)).goals.find((g) => g.id === goalId)?.containers).toBe('always');
  // Sent: the option goes back to "follow the setting" for the next goal.
  await expect(option).not.toBeChecked();

  // The goal view says the choice in words, with the switch on.
  const goal = win.getByRole('article', { name: /Goal:/ });
  const choice = goal.getByTestId('goal-containers');
  await expect(choice).toHaveAttribute('data-containers', 'always', { timeout: 15_000 });
  await expect(choice.getByTestId('goal-containers-words')).toHaveText('Every card of this goal runs in a container, whatever the setting.');
  await expect(choice.getByRole('switch', { name: SWITCH })).toHaveAttribute('aria-checked', 'true');

  // The card: in a container, because the user chose it for this goal.
  await expect.poll(async () => (await cardOf(win, goalId))?.container ?? null, { timeout: 30_000 }).toMatchObject({ source: 'goal', state: 'container' });
  await waitingMerge(win, goalId);
  // The scripted runs had a container (see the header), and nothing fell back to the computer silently.
  expect(runtimeLog()).toMatch(BOXED_RUN);
  await axe(win, '[data-testid="goal-containers"]', 'goal forced, ready');

  // The Hive's lanes say which runs had a container (the insect's and the Inspector's; never the Queen's planning).
  await nav(win, 'Hive');
  const lanes = win.getByRole('table');
  await expect(lanes.getByTestId('lane-container').first()).toHaveText('In a container', { timeout: 15_000 });
  const boxedLanes = (await snapshot(win)).agents.filter((x) => x.container).map((x) => x.role);
  expect(boxedLanes).toContain('insect');
  expect(boxedLanes).not.toContain('queen');
  await axe(win, 'table', 'lanes with a container');

  const card = await openCard(win, null);
  await expect(card).toHaveAccessibleName(/In a container: /);
  await expect(card.getByTestId('card-container')).toHaveText('In a container');
  await card.click();
  const detail = win.getByRole('complementary', { name: 'Card details' });
  const section = detail.getByTestId('card-container-detail');
  await expect(section.getByTestId('card-container')).toHaveAttribute('data-state', 'container');
  await expect(section).toContainText('You chose containers for this goal.');
  await expect(section.getByTestId('card-container-reason')).not.toBeEmpty();
  await axe(win, '[aria-label="Card details"]', 'card detail, in a container');
});

test('no runtime: the marked goal\'s card waits for containers and the hive pauses; following the setting again lets it carry on', async () => {
  test.setTimeout(150_000);
  // A runtime program that can't start = neither Docker nor Podman found.
  t = await launchApp({ env: { INSECTOIDS_E2E_CONTAINER_RUNTIME: FAKE_RUNTIME, INSECTOIDS_E2E_CONTAINER_NODE: join(scratch, 'no-such-node.exe') } });
  const { win } = t;
  await win.emulateMedia({ reducedMotion: 'reduce' });
  await ready(win);
  await expect.poll(async () => (await status(win)).runtime.state, { timeout: 30_000 }).toBe('missing');

  // Checking the option says straight away that Docker isn't ready, and what that means for the goal.
  await win.getByRole('checkbox', { name: SWITCH }).check();
  const note = win.getByTestId('goal-containers-note');
  await expect(note).toContainText("Docker isn't ready yet: neither Docker nor Podman is on this computer.");
  await expect(note).toContainText('never run on this computer instead');
  await expect(win.getByRole('checkbox', { name: SWITCH })).toHaveAccessibleDescription(/Docker isn't ready yet/);
  await axe(win, 'main', 'composer, containers not ready');
  await win.getByLabel('Message the Queen').fill(GOAL);
  await win.getByLabel('Message the Queen').press('Enter');
  const goalId = await goalIdOf(win, GOAL);

  // D1 behaviour: the card waits with the reason, the hive pauses, and no insect started.
  await expect.poll(async () => (await snapshot(win)).hive.pausedReason ?? '', { timeout: 30_000 }).toMatch(/^Container mode:/);
  await expect.poll(async () => (await cardOf(win, goalId))?.container ?? null, { timeout: 30_000 }).toMatchObject({ source: 'goal', state: 'waiting' });
  expect((await snapshot(win)).agents.filter((a) => a.role === 'insect')).toEqual([]);

  const goal = win.getByRole('article', { name: /Goal:/ });
  const choice = goal.getByTestId('goal-containers');
  await expect(choice.getByRole('status').filter({ hasText: "Containers aren't ready" })).toContainText("Docker isn't ready yet");
  await axe(win, '[data-testid="goal-containers"]', 'goal forced, not ready');

  const card = await openCard(win, null);
  await expect(card).toHaveAccessibleName(/Waiting for containers: /);
  await card.click();
  const section = win.getByRole('complementary', { name: 'Card details' }).getByTestId('card-container-detail');
  await expect(section.getByTestId('card-container')).toHaveText('Waiting for containers');
  await expect(section).toContainText('It never runs on this computer instead.');
  await axe(win, '[aria-label="Card details"]', 'card detail, waiting');

  // Switch the goal back to following the setting (Off): it carries on, with commands on the computer as before.
  await nav(win, 'Queen');
  const sw = win.getByRole('article', { name: /Goal:/ }).getByRole('switch', { name: SWITCH });
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(sw).toBeFocused();
  await expect.poll(async () => (await snapshot(win)).goals.find((g) => g.id === goalId)?.containers, { timeout: 15_000 }).toBe('auto');
  await expect(win.getByTestId('goal-containers-words')).toHaveText('Follows the container setting (Off): its cards run on this computer, guarded as usual.');
  await waitingMerge(win, goalId);
  expect((await snapshot(win)).hive.paused).toBe(false);
});

test('the Queen marks an "install" card: suggested with the setting Off, in a container with "When needed"', async () => {
  test.setTimeout(180_000);
  t = await launchApp({ env: readyEnv() });
  const { win } = t;
  await win.emulateMedia({ reducedMotion: 'reduce' });
  await ready(win);

  // Off: the Queen's mark is only a suggestion; the card runs on the computer.
  expect(await command(win, { type: 'submitGoal', text: INSTALL_GOAL })).toEqual({ ok: true });
  const first = await goalIdOf(win, INSTALL_GOAL);
  await expect.poll(async () => (await cardOf(win, first))?.container ?? null, { timeout: 30_000 }).toMatchObject({ source: 'queen', state: 'suggested' });
  const card = await openCard(win, null);
  await expect(card).toHaveAccessibleName(/Container suggested: /);
  await card.click();
  const section = win.getByRole('complementary', { name: 'Card details' }).getByTestId('card-container-detail');
  await expect(section.getByTestId('card-container')).toHaveText('Container suggested');
  await expect(section).toContainText('The Queen marked it.');
  await axe(win, '[aria-label="Card details"]', 'card detail, suggested');
  expect(await command(win, { type: 'approve', approvalId: await waitingMerge(win, first) })).toEqual({ ok: true });
  expect(runtimeLog()).not.toMatch(BOXED_RUN);

  // When needed, from Settings: the next marked card runs in a container.
  const box = await openSettings(win);
  await box.getByRole('radio', { name: 'When needed', exact: true }).click();
  await expect.poll(async () => (await status(win)).settings.mode, { timeout: 15_000 }).toBe('auto');
  const second = `${INSTALL_GOAL}, again`;
  expect(await command(win, { type: 'submitGoal', text: second })).toEqual({ ok: true });
  const secondId = await goalIdOf(win, second);
  await expect.poll(async () => (await cardOf(win, secondId))?.container ?? null, { timeout: 30_000 }).toMatchObject({ source: 'queen', state: 'container' });
  await waitingMerge(win, secondId);
  expect(runtimeLog()).toMatch(BOXED_RUN);

  // The Taskboard shows the second goal's card in a container.
  const boxed = await openCard(win, secondId);
  await expect(boxed).toHaveAccessibleName(/In a container: /);
  await boxed.click();
  const detail = win.getByRole('complementary', { name: 'Card details' }).getByTestId('card-container-detail');
  await expect(detail.getByTestId('card-container')).toHaveText('In a container');
  await expect(detail.getByTestId('card-container-reason')).toContainText('it installs packages');

  // The goal's own choice can still be switched on later from its goal view ("When needed" follows the setting).
  await nav(win, 'Queen');
  const thread = win.getByRole('article', { name: /Goal:/ }).filter({ hasText: second });
  await expect(thread.getByTestId('goal-containers-words')).toContainText('Follows the container setting (When needed)');
  const sw = thread.getByRole('switch', { name: SWITCH });
  await sw.click();
  await expect.poll(async () => (await snapshot(win)).goals.find((g) => g.id === secondId)?.containers, { timeout: 15_000 }).toBe('always');
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  // From now on the card's reason is the user's choice, not the Queen's mark.
  await expect.poll(async () => (await cardOf(win, secondId))?.container?.source, { timeout: 15_000 }).toBe('goal');
});
