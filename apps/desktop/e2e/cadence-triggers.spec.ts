import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { HiveApi } from '@insectoids/shared';
import { type LaunchedApp, launchApp, repoGit } from './support/launch';

/**
 * Cadence triggers (Phase 3 A3): a cadence that starts when files land in a project folder, and one that starts
 * when something happens in the hive. Every run is still a goal for the Queen. The fake engine's Queen plans any
 * goal in two waves, so a run's plan waits for approval at the default autonomy ("small plans run").
 * File changes settle for about 5 s before a run starts, so the waits here are generous.
 */
type Win = { insectoids: { hive: HiveApi; brainStatus(): Promise<{ state: string }> } };
const snapshot = (win: Page) => win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.snapshot());
const command = (win: Page, cmd: Parameters<HiveApi['command']>[0]) =>
  win.evaluate((c) => (globalThis as unknown as Win).insectoids.hive.command(c), cmd);
const runsOf = (win: Page, cadenceId: string) =>
  win.evaluate((id) => (globalThis as unknown as Win).insectoids.hive.cadenceRuns({ cadenceId: id, limit: 50 }), cadenceId);

let t: LaunchedApp;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  t = await launchApp();
  await expect
    .poll(() => t.win.evaluate(async () => (await (globalThis as unknown as Win).insectoids.brainStatus()).state), { timeout: 30_000 })
    .toBe('ready');
  // No Scout survey before planning: the runs here only need the goal to start.
  await command(t.win, { type: 'setManagers', scoutBeforePlanning: false });
  mkdirSync(join(t.repo, 'inbox'), { recursive: true });
});

test.afterAll(async () => {
  await t?.close();
});

async function openCadence(win: Page): Promise<void> {
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Cadence' }).click();
  await expect(win.getByRole('heading', { level: 1, name: 'Cadence' })).toBeVisible();
}

async function newForm(win: Page) {
  const empty = win.getByTestId('cadence-empty');
  if (await empty.isVisible()) await empty.getByRole('button', { name: 'New cadence' }).click();
  else await win.getByRole('button', { name: 'New cadence' }).first().click();
  const form = win.getByTestId('cadence-form');
  await expect(form).toBeVisible();
  return form;
}

test('a file cadence on a folder that does not exist says so in words, and nothing is saved', async () => {
  const { win } = t;
  await openCadence(win);
  const form = await newForm(win);
  await form.getByLabel('Name').fill('Sort the drafts');
  await form.getByRole('radio', { name: 'When files change in a folder' }).click();
  await form.getByLabel('Folder in the project').fill('drafts-missing');
  await form.getByLabel('What the Queen should do each time').fill('Sort the new drafts into folders');
  await form.getByRole('button', { name: 'Create cadence' }).click();
  const alert = form.getByRole('alert').or(form.getByRole('status')).filter({ hasText: 'Check the form' });
  // The exact words come from the hive; they name the problem with the folder.
  await expect(alert).toContainText(/folder/i);
  expect((await snapshot(win)).cadences.filter((x) => !x.builtIn)).toHaveLength(0);

  // A folder outside the project is refused before anything is sent.
  await form.getByLabel('Folder in the project').fill('../elsewhere');
  await form.getByRole('button', { name: 'Create cadence' }).click();
  await expect(alert).toContainText('Folder: The folder must be inside the project.');
  await form.getByRole('button', { name: 'Cancel' }).click();
});

test('files landing in a watched folder start one run that lists them; other files and deletions do not', async () => {
  test.setTimeout(90_000);
  const { win } = t;
  const form = await newForm(win);
  await form.getByLabel('Name').fill('Summarise new notes');
  await form.getByRole('radio', { name: 'When files change in a folder' }).click();
  await form.getByLabel('Folder in the project').fill('inbox');
  await form.getByLabel('Only files named like (optional)').fill('*.md');
  await form.getByLabel('What the Queen should do each time').fill('Summarise the new notes in docs/notes.md');
  await form.getByRole('button', { name: 'Create cadence' }).click();
  await expect(form).toHaveCount(0);

  const row = win.getByTestId('cadence-row').filter({ hasText: 'Summarise new notes' });
  await expect(row).toBeVisible();
  await expect(row.getByTestId('cadence-next')).toHaveText('Waits for files in inbox (*.md)');
  await expect(row.getByRole('switch', { name: 'Run "Summarise new notes" when it is triggered' })).toHaveAttribute('aria-checked', 'true');
  const c = (await snapshot(win)).cadences.find((x) => x.name === 'Summarise new notes')!;
  expect(c.when).toEqual({ type: 'file', folder: 'inbox', pattern: '*.md' });
  expect(c.nextRunAt).toBeNull();

  // Let the watcher start, then drop a file that doesn't match: nothing runs.
  await win.waitForTimeout(1_500);
  writeFileSync(join(t.repo, 'inbox', 'todo.txt'), 'not a note\n');
  await win.waitForTimeout(9_000);
  expect(await runsOf(win, c.id)).toHaveLength(0);

  // Two notes together: one run, and the goal lists both.
  writeFileSync(join(t.repo, 'inbox', 'a.md'), '# A\n');
  writeFileSync(join(t.repo, 'inbox', 'b.md'), '# B\n');
  await expect.poll(async () => (await runsOf(win, c.id)).length, { timeout: 30_000 }).toBe(1);
  const [run] = await runsOf(win, c.id);
  expect(run).toMatchObject({ reason: 'file', outcome: 'started' });
  const goal = (await snapshot(win)).goals.find((g) => g.id === run!.goalId)!;
  expect(goal.cadenceId).toBe(c.id);
  expect(goal.text).toContain('a.md');
  expect(goal.text).toContain('b.md');
  expect(goal.text).not.toContain('todo.txt');

  await row.getByRole('button', { name: 'Runs' }).click();
  const history = win.getByTestId('cadence-history');
  await expect(history.getByTestId('cadence-run').first()).toContainText('Files changed');
  await expect(history.getByTestId('cadence-run').first()).toContainText('Started');
  // Still exactly one run (the second file didn't make a second one).
  expect(await runsOf(win, c.id)).toHaveLength(1);
});

test('an event cadence follows another cadence\'s goals; the list says what it waits for', async () => {
  const { win } = t;
  // A scheduled cadence to follow.
  const first = await newForm(win);
  await first.getByLabel('Name').fill('Weekly report');
  await first.getByLabel('Every', { exact: true }).fill('2');
  await first.getByLabel('What the Queen should do each time').fill('Write the weekly report');
  await first.getByRole('button', { name: 'Create cadence' }).click();
  await expect(first).toHaveCount(0);

  const form = await newForm(win);
  await form.getByLabel('Name').fill('Post a summary');
  await form.getByRole('radio', { name: 'When something happens in the hive' }).click();
  const events = form.getByRole('radiogroup', { name: 'What happens' });
  await expect(events.getByRole('radio', { name: 'A goal finishes' })).toHaveAttribute('aria-checked', 'true');
  const from = form.getByLabel('Only goals from cadence');
  // Only cadences whose goals can trigger it are offered (not other event cadences).
  await expect(from.locator('option')).toHaveText(['Any goal', 'Summarise new notes', 'Weekly report']);
  await from.selectOption({ label: 'Weekly report' });
  await expect(form).toContainText("can't loop");
  await form.getByLabel('What the Queen should do each time').fill('Post a short summary of the report');
  await form.getByRole('button', { name: 'Create cadence' }).click();
  await expect(form).toHaveCount(0);

  const s = await snapshot(win);
  const report = s.cadences.find((x) => x.name === 'Weekly report')!;
  const follow = s.cadences.find((x) => x.name === 'Post a summary')!;
  expect(follow.when).toEqual({ type: 'event', on: 'goal-done', cadenceId: report.id });
  expect(follow.nextRunAt).toBeNull();
  const row = win.getByTestId('cadence-row').filter({ hasText: 'Post a summary' });
  await expect(row.getByTestId('cadence-next')).toHaveText('Waits for a goal to finish');
  await expect(row.getByTestId('cadence-when')).toContainText(/finish/i);

  // The budget-warning choice has no cadence filter.
  await row.getByRole('button', { name: 'Edit' }).click();
  const edit = win.getByTestId('cadence-form');
  await edit.getByRole('radio', { name: 'A goal has used 75% of its budget' }).click();
  await expect(edit.getByLabel('Only goals from cadence')).toHaveCount(0);
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(edit).toHaveCount(0);
  await expect(row.getByTestId('cadence-next')).toHaveText('Waits for a goal to use 75% of its budget');
  expect((await snapshot(win)).cadences.find((x) => x.name === 'Post a summary')!.when).toEqual({ type: 'event', on: 'budget-warning', cadenceId: null });

  // Run now works for every kind of cadence.
  await row.getByRole('button', { name: 'Run now' }).click();
  await expect.poll(async () => (await runsOf(win, follow.id)).map((r) => `${r.reason}:${r.outcome}`), { timeout: 20_000 }).toEqual(['manual:started']);
});

test('when a followed cadence\'s goal finishes, the follow-up starts (reason: hive event)', async () => {
  test.setTimeout(120_000);
  const { win } = t;
  const s0 = await snapshot(win);
  const report = s0.cadences.find((x) => x.name === 'Weekly report')!;
  // A fresh follow-up on "a goal finishes" of the report cadence.
  expect(
    await command(win, {
      type: 'createCadence',
      cadence: {
        name: 'After the report',
        when: { type: 'event', on: 'goal-done', cadenceId: report.id },
        goal: 'Tell the team the report is ready',
        budgetTokens: 50_000,
        autonomy: 'small-plans',
        enabled: true,
      },
    }),
  ).toEqual({ ok: true });
  const follow = (await snapshot(win)).cadences.find((x) => x.name === 'After the report')!;
  // The notes from the file test are committed, so the merge into main meets a clean project.
  repoGit(t.repo, 'add', '-A');
  repoGit(t.repo, 'commit', '-q', '-m', 'notes');

  // Run the report now, approve its plan, let the insects finish, then decide its merge.
  expect(await command(win, { type: 'runCadenceNow', id: report.id })).toEqual({ ok: true });
  await expect.poll(async () => (await snapshot(win)).goals.find((g) => g.cadenceId === report.id)?.id ?? null, { timeout: 20_000 }).not.toBeNull();
  const reportGoal = (await snapshot(win)).goals.find((g) => g.cadenceId === report.id)!.id;
  const waitingApproval = async (kind: string) =>
    (await snapshot(win)).approvals.find((a) => a.goalId === reportGoal && a.kind === kind && a.status === 'waiting')?.id ?? null;
  await expect.poll(() => waitingApproval('plan'), { timeout: 30_000 }).not.toBeNull();
  expect(await command(win, { type: 'approve', approvalId: (await waitingApproval('plan'))! })).toEqual({ ok: true });
  await expect.poll(() => waitingApproval('merge'), { timeout: 60_000 }).not.toBeNull();
  expect(await command(win, { type: 'approve', approvalId: (await waitingApproval('merge'))! })).toEqual({ ok: true });

  await expect.poll(async () => (await runsOf(win, follow.id)).map((r) => `${r.reason}:${r.outcome}`), { timeout: 30_000 }).toEqual(['event:started']);
  const [run] = await runsOf(win, follow.id);
  const followGoal = (await snapshot(win)).goals.find((g) => g.id === run!.goalId)!;
  expect(followGoal.cadenceId).toBe(follow.id);

  await openCadence(win);
  const row = win.getByTestId('cadence-row').filter({ hasText: 'After the report' });
  await row.getByRole('button', { name: 'Runs' }).click();
  await expect(win.getByTestId('cadence-history').getByTestId('cadence-run').first()).toContainText('Hive event');
});
