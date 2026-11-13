import { expect, test } from '@playwright/test';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';
import { holdUntilDone } from './support/hold';

/**
 * Self-learning skills (Capabilities 03-D6; Phase 2 C3): when the hive sees the same successful work
 * repeated (3+ times), the Librarian drafts a skill. It is scanned, waits for the user's OK as
 * "New skill from repeated work", and shows in the Library as a Learned draft; approving makes it Ready.
 */
/** Goal text that makes the scripted hive repeat one kind of work 3 times (harness demo.ts, worker K). */
const GOAL = 'Add three greeting pages';

let t: LaunchedApp;

test.beforeAll(async () => {
  t = await launchApp();
  await expect(t.win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
});

test.afterAll(async () => {
  await t?.close();
});

const nav = (name: RegExp | string) => t.win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: typeof name === 'string' });

test('repeated successful work produces a skill proposal the user can approve', async () => {
  test.setTimeout(150_000);
  const { win } = t;
  expect(await win.evaluate((text) => (globalThis as unknown as AppWindow).insectoids.hive.command({ type: 'submitGoal', text }), GOAL)).toEqual({ ok: true });

  // Approve a multi-wave plan if the Queen asks (Hive 02-D11), then wait for the proposal.
  await expect
    .poll(
      async () =>
        win.evaluate(async () => {
          const hive = (globalThis as unknown as AppWindow).insectoids.hive;
          const s = await hive.snapshot();
          const plan = s.approvals.find((a) => a.kind === 'plan' && a.status === 'waiting');
          if (plan) await hive.command({ type: 'approve', approvalId: plan.id });
          return s.approvals.some((a) => a.kind === 'skill_proposal' && a.status === 'waiting');
        }),
      { timeout: 120_000 },
    )
    .toBe(true);

  // Approvals: it reads as a new skill from repeated work, and links to the Library.
  await nav(/^Approvals/).click();
  await win.getByRole('button', { name: /New skills/ }).click();
  const row = win.getByRole('list', { name: 'Approvals' }).getByRole('button').first();
  await expect(row).toContainText('New skill from repeated work');
  await row.click();
  await win.getByTestId('approval-open-library').click();

  // Library: a Learned draft with its scan; approving makes it Ready.
  const detail = win.getByTestId('library-detail');
  await expect(detail).toBeVisible({ timeout: 15_000 });
  await expect(detail.getByTestId('origin-badge')).toHaveAttribute('data-origin', 'learned');
  await expect(detail.getByTestId('library-status')).toHaveText(/Draft/);
  const verdict = await detail.getByTestId('scan-verdict').getAttribute('data-verdict');
  expect(verdict === 'clean' || verdict === 'warn', `a learned skill is never blocked (got ${verdict})`).toBe(true);
  // A clean scan approves with a click; one that needs a look needs a deliberate hold.
  if (verdict === 'warn') await holdUntilDone(win, detail.getByTestId('draft-approve'));
  else await detail.getByTestId('draft-approve').click();
  await expect(detail.getByTestId('library-status')).toHaveText(/Ready/, { timeout: 15_000 });

  // The proposal is decided.
  const left = await win.evaluate(async () =>
    (await (globalThis as unknown as AppWindow).insectoids.hive.snapshot()).approvals.filter((a) => a.kind === 'skill_proposal' && a.status === 'waiting').length,
  );
  expect(left).toBe(0);
});
