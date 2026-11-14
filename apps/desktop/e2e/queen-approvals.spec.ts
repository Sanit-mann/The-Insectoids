import { type Locator, type Page, expect, test } from '@playwright/test';
import { holdUntilDone } from './support/hold';
import { type LaunchedApp, launchApp, repoGit } from './support/launch';

/** Approve a card: hold-to-approve for destructive items, a click otherwise. */
async function approveIn(card: Locator, page: Page): Promise<void> {
  const hold = card.getByRole('button', { name: /press and hold/i });
  if (await hold.count()) {
    await holdUntilDone(page, hold);
  } else {
    await card.getByRole('button', { name: /^Approve/ }).click();
  }
}

test.describe('with a project', () => {
  let launched: LaunchedApp;
  let win: Page;

  test.beforeAll(async () => {
    launched = await launchApp();
    win = launched.win;
  });
  test.afterAll(async () => {
    await launched?.close();
  });

  test('the Queen chat shows the project and an empty thread', async () => {
    await expect(win.getByRole('heading', { name: 'Give the hive its first goal' })).toBeVisible({ timeout: 20_000 });
    await expect(win.getByText('sample project', { exact: false }).first()).toBeVisible();
    await expect(win.getByRole('button', { name: 'Change project' })).toBeVisible();
    await expect(win.getByTestId('hive-pill')).toHaveText(/Hive idle/);
  });

  test('a goal goes from plan approval to done, and its merge is approved in the inbox', async () => {
    test.setTimeout(120_000);
    const prompt = win.getByLabel('Message the Queen');
    await expect(prompt).toBeEnabled({ timeout: 20_000 });
    await prompt.fill('Say hello from the hive');
    await prompt.press('Enter');

    // You: the goal. Queen: a two-wave plan that waits for approval (Hive D11).
    const goal = win.getByRole('article', { name: /Goal:/ });
    await expect(goal.getByText('Say hello from the hive')).toBeVisible();
    const plan = goal.getByTestId('plan');
    await expect(plan).toContainText('Say hello', { timeout: 30_000 });
    await expect(plan).toContainText('2 waves');
    await expect(plan).toContainText('Write hello.txt');
    await expect(win.getByTestId('approvals-badge')).toContainText('1');

    // Approve inline; cards progress.
    const planCard = goal.locator('[data-approval-id]').first();
    await approveIn(planCard, win);
    await expect(goal.getByTestId('goal-progress')).toBeVisible({ timeout: 30_000 });
    await expect(goal.getByTestId('goal-progress')).toContainText(/of 3 cards done/);

    // When every card is verified the merge into main waits for you: inline in the thread and in the inbox.
    await expect(goal.locator('[data-approval-id]').filter({ hasText: 'into your main branch' })).toBeVisible({ timeout: 90_000 });
    await expect(win.getByTestId('approvals-badge')).toContainText('1');
    await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Approvals/ }).click();
    await expect(win.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
    await win.getByRole('button', { name: /^Merges/ }).click();
    const detail = win.locator('[data-approval-id]');
    await expect(detail).toContainText('into your main branch');
    await approveIn(detail, win);

    // Decided: greyed in the list, and the goal is done in the Queen chat.
    await expect(win.getByRole('list', { name: 'Approvals' }).getByText('Approved').first()).toBeVisible({ timeout: 30_000 });
    await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Queen' }).click();
    await expect(win.getByTestId('goal-status')).toHaveText('Done', { timeout: 30_000 });
    // The insects' files reached main (README.md was the only file before).
    expect(repoGit(launched.repo, 'ls-files').trim().split(/\s+/).length).toBeGreaterThan(1);
  });

  test('the inbox filters by kind and walks the list with the arrow keys', async () => {
    await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Approvals/ }).click();
    await win.getByRole('button', { name: /^All/ }).click();
    const list = win.getByRole('list', { name: 'Approvals' });
    const items = list.getByRole('button');
    await expect(items).toHaveCount(2); // the plan and the merge, both decided
    await items.first().focus();
    await win.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await expect(items.nth(1)).toHaveAttribute('aria-current', 'true');
    await win.getByRole('button', { name: /^Cadence proposals/ }).click();
    await expect(win.getByText('Nothing is waiting for you.')).toBeVisible();
  });
});

test('without a project the Queen asks for a folder and the composer is not shown', async () => {
  const launched = await launchApp({ project: 'none' });
  try {
    const { win } = launched;
    await expect(win.getByRole('heading', { name: 'Choose a project for the hive' })).toBeVisible({ timeout: 20_000 });
    await expect(win.getByRole('button', { name: 'Choose project folder' })).toBeVisible();
    await expect(win.getByLabel('Message the Queen')).toHaveCount(0);
    await expect(win.getByRole('complementary', { name: 'Hive status' })).toContainText('Nothing is waiting for you.');
  } finally {
    await launched.close();
  }
});
