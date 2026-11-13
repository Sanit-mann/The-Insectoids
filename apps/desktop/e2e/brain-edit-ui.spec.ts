import { type Page, expect, test } from '@playwright/test';
import { holdUntilDone } from './support/hold';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * Brain reader, Phase 2 B5 (Memory 01-D12): the user edits a record (a new version that counts as
 * confirmed); if an agent changed it meanwhile, the reader shows both texts instead of overwriting, and
 * the user keeps theirs or takes the agent's. Archive is a hold, and an archived record leaves search.
 * The agent's change comes from an e2e-only hook in the main process (never reachable from the page).
 */
let launched: LaunchedApp;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  launched = await launchApp({ env: { INSECTOIDS_E2E_BRAIN_SEED: '1' } });
  const { win } = launched;
  await expect(win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Brain' }).click();
});

test.afterAll(async () => {
  await launched?.close();
});

async function idOf(win: Page, title: string): Promise<string> {
  const hits = await win.evaluate((q) => (globalThis as unknown as AppWindow).insectoids.hive.brainSearch({ query: q }), title);
  const hit = hits.find((h) => h.title === title);
  if (!hit) throw new Error(`The seeded Brain has no "${title}".`);
  return hit.id;
}

/** Search the Brain on the Notes view and open the record with this exact title. */
async function open(win: Page, title: string): Promise<void> {
  await win.getByRole('tablist', { name: 'Brain view' }).getByRole('tab', { name: 'Notes' }).click();
  await win.getByTestId('brain-search').fill(title);
  await win.getByTestId('brain-hit').filter({ hasText: title }).first().click();
  await expect(win.getByTestId('brain-reader').getByRole('heading', { name: title })).toBeVisible({ timeout: 10_000 });
}

/** The agent's change (main process, e2e only). */
async function agentEdits(id: string, body: string): Promise<void> {
  await launched.app.evaluate(
    async (_electron, [recordId, text]) => {
      const hook = (globalThis as unknown as { __insectoidsE2E: { agentEditRecord: (i: string, b: string) => Promise<void> } }).__insectoidsE2E;
      await hook.agentEditRecord(recordId, text);
    },
    [id, body] as const,
  );
}

test('an edit is saved as a new version and counts as confirmed', async () => {
  const { win } = launched;
  await open(win, 'Hosting provider');
  const reader = win.getByTestId('brain-reader');
  await expect(reader.getByTestId('trust-badge')).toHaveText('Unconfirmed');
  await expect(reader).toContainText(/1 · updated/);

  await reader.getByTestId('record-edit').click();
  const editor = reader.getByTestId('record-editor');
  await expect(editor).toContainText('counts as confirmed');
  await editor.getByLabel('Text').fill('The site is hosted on Vercel, with a preview for every branch.');
  await editor.getByTestId('record-save').click();

  await expect(reader.getByTestId('record-editor')).toHaveCount(0);
  await expect(reader).toContainText('with a preview for every branch');
  await expect(reader.getByTestId('trust-badge')).toHaveText('Confirmed');
  await expect(reader).toContainText(/2 · updated/);
  await expect(reader.getByRole('heading', { name: 'Versions' })).toBeVisible();
  await expect(reader).toContainText('by user');
});

test('an agent change while editing shows the conflict, and "Keep mine" saves the user\'s text', async () => {
  const { win } = launched;
  const title = 'Order emails come from the shop address';
  const id = await idOf(win, title);
  await open(win, title);
  const reader = win.getByTestId('brain-reader');
  await reader.getByTestId('record-edit').click();
  await reader.getByTestId('record-editor').getByLabel('Text').fill('Mine: order emails come from orders@ the shop address.');

  await agentEdits(id, 'Theirs: order emails now come from a no-reply address.');
  await reader.getByTestId('record-save').click();

  const conflict = reader.getByTestId('record-conflict');
  await expect(conflict).toBeVisible({ timeout: 10_000 });
  await expect(conflict).toContainText('Changed while you were editing');
  await expect(conflict.getByTestId('conflict-theirs')).toContainText('Theirs: order emails now come from a no-reply address.');
  await expect(conflict.getByTestId('conflict-yours')).toContainText('Mine: order emails come from orders@');

  await conflict.getByTestId('conflict-keep-mine').click();
  await expect(reader.getByTestId('record-conflict')).toHaveCount(0);
  await expect(reader).toContainText('Mine: order emails come from orders@');
  await expect(reader.getByTestId('trust-badge')).toHaveText('Confirmed');
  // Nothing lost: the agent's version is in the history too.
  await expect(reader).toContainText(/3 · updated/);
});

test('"Use theirs" drops the user\'s draft and shows the agent\'s text', async () => {
  const { win } = launched;
  const title = 'Take payments by card only';
  const id = await idOf(win, title);
  await open(win, title);
  const reader = win.getByTestId('brain-reader');
  const trustBefore = await reader.getByTestId('trust-badge').textContent();
  await reader.getByTestId('record-edit').click();
  await reader.getByTestId('record-editor').getByLabel('Text').fill('My draft that should be dropped.');
  await agentEdits(id, 'Cards and PayPal at launch; still no bank transfers.');
  await reader.getByTestId('record-save').click();

  const conflict = reader.getByTestId('record-conflict');
  await expect(conflict).toBeVisible({ timeout: 10_000 });
  await conflict.getByTestId('conflict-use-theirs').click();
  await expect(reader.getByTestId('record-conflict')).toHaveCount(0);
  await expect(reader.getByTestId('record-editor')).toHaveCount(0);
  await expect(reader).toContainText('Cards and PayPal at launch');
  await expect(reader).not.toContainText('My draft that should be dropped.');
  await expect(reader.getByTestId('trust-badge')).toHaveText(trustBefore ?? '');
});

test('archiving takes a hold, keeps the record readable, and takes it out of search', async () => {
  const { win } = launched;
  await open(win, 'Scratch idea');
  const reader = win.getByTestId('brain-reader');
  await holdUntilDone(win, reader.getByTestId('record-archive'));
  await expect(reader.getByText('Archived', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(reader.getByTestId('record-edit')).toHaveCount(0);
  await expect(reader.getByTestId('record-archive')).toHaveCount(0);

  const hits = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.brainSearch({ query: 'Scratch idea' }));
  expect(hits.filter((h) => h.title === 'Scratch idea')).toHaveLength(0);
});
