import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { type HiveApi, MAINTENANCE_JOBS } from '@insectoids/shared';
import { launchApp } from './support/launch';

/**
 * Accessibility (WCAG 2.2 AA; Phase 3 C1), part two: the states the screen-by-screen pass (accessibility.spec.ts)
 * never reaches. The setup wizard step by step, and inside the app the forms, side panels, detail views and dialogs
 * that only open after a click: the Queen's goal with its plan waiting and then running, a selected approval, every
 * "When" of the cadence form, a cadence's runs, the webhook panel, Housekeeping's schedule editor, both digests,
 * Settings' backups and the restore confirm, a Brain record, a Library item, the Connections tabs, a Taskboard card.
 *
 * Each state is checked in both themes. Serious and critical findings fail the test; every finding (any impact) is
 * written to `test-results/axe-states-report.json` so moderate and minor ones can be read and fixed too.
 */
const THEMES = ['dark', 'light'] as const;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

type Win = { insectoids: { hive: HiveApi } };
interface Finding {
  theme: string;
  state: string;
  id: string;
  impact: string | null;
  help: string;
  nodes: Array<{ target: string; summary: string }>;
}

/** This test's findings (each test launches its own app, so a failure in one never stops the other). */
let findings: Finding[] = [];
let serious: string[] = [];

test.beforeEach(() => {
  findings = [];
  serious = [];
});

test.afterEach(() => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-results');
  mkdirSync(dir, { recursive: true });
  const which = test.info().title.includes('setup wizard') ? 'wizard' : 'app';
  writeFileSync(join(dir, `axe-states-${which}.json`), `${JSON.stringify(findings, null, 2)}\n`);
});

/**
 * Checks what is on screen now in both themes. The theme is switched on <html> directly (as the top-bar toggle does),
 * so open dialogs stay open; the page goes back to dark afterwards.
 */
async function check(win: Page, state: string): Promise<void> {
  for (const theme of THEMES) {
    await win.evaluate((t) => {
      (globalThis as unknown as { document: { documentElement: { dataset: Record<string, string> } } }).document.documentElement.dataset['theme'] = t;
    }, theme);
    // Colour transitions (150 ms) and entrance animations settle before axe reads computed colours (a card fading in
    // reads as low contrast). Endless ones (a pulsing dot) are ignored.
    await win.waitForTimeout(300);
    await win
      .waitForFunction("document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity)", undefined, { timeout: 3_000 })
      .catch(() => undefined);
    // Legacy mode: Electron can't open the extra page AxeBuilder normally uses to check frames (the app has none).
    const r = await new AxeBuilder({ page: win }).setLegacyMode(true).withTags(TAGS).analyze();
    for (const v of r.violations) {
      const f: Finding = {
        theme,
        state,
        id: v.id,
        impact: v.impact ?? null,
        help: v.help,
        nodes: v.nodes.slice(0, 8).map((n) => ({ target: n.target.join(' '), summary: (n.failureSummary ?? '').split('\n').slice(0, 3).join(' ') })),
      };
      findings.push(f);
      if (f.impact === 'serious' || f.impact === 'critical') serious.push(`[${theme}] ${state}: ${f.id} (${f.impact}) ${f.help} → ${f.nodes.map((n) => n.target).join(', ')}`);
    }
  }
  await win.evaluate(() => {
    (globalThis as unknown as { document: { documentElement: { dataset: Record<string, string> } } }).document.documentElement.dataset['theme'] = 'dark';
  });
}

const command = (win: Page, cmd: Parameters<HiveApi['command']>[0]) => win.evaluate((c) => (globalThis as unknown as Win).insectoids.hive.command(c), cmd);
const snapshot = (win: Page) => win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.snapshot());
const nav = (win: Page, screen: string): Promise<void> => win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${screen}`) }).click();

async function open(win: Page, screen: string): Promise<void> {
  await nav(win, screen);
  await expect(win.getByRole('heading', { level: 1, name: screen })).toBeVisible({ timeout: 15_000 });
  await win.waitForTimeout(400);
}

/** Opens a dialog with `opener`, checks it, closes it with `closeName`, and checks focus went back to the opener. */
async function checkDialog(win: Page, state: string, opener: Locator, dialog: Locator, closeName: string): Promise<void> {
  await opener.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName(/.+/);
  await check(win, state);
  await dialog.getByRole('button', { name: closeName, exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(opener, `${state}: focus goes back to the button that opened it`).toBeFocused();
}

test('the first-run setup wizard passes axe at every step, in both themes', async () => {
  test.setTimeout(150_000);
  const t = await launchApp({ onboarded: false, project: 'none' });
  try {
    const { win } = t;
    // A smaller window, like CI screens: narrow layouts scroll sideways, and those regions must be keyboard-reachable.
    await t.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1024, 720));
    const step = win.getByTestId('setup-step-label');
    await expect(win.getByRole('heading', { name: 'Welcome to The Insectoids' })).toBeVisible({ timeout: 20_000 });
    await check(win, 'Setup 1 · Welcome');
    await win.getByRole('button', { name: 'Get started' }).click();

    await expect(step).toContainText('Step 2 of 9');
    await check(win, 'Setup 2 · Brain folder');
    await win.getByRole('button', { name: 'Skip for now' }).click();

    await expect(step).toContainText('Step 3 of 9');
    await expect(win.getByTestId('setup-engines-summary')).not.toHaveAttribute('data-ready', '0', { timeout: 30_000 });
    await check(win, 'Setup 3 · AI engines');
    await win.getByRole('button', { name: 'Skip for now' }).click();

    await expect(step).toContainText('Step 4 of 9');
    await check(win, 'Setup 4 · Providers');
    await win.getByTestId('setup-providers').getByRole('button', { name: 'Add a provider' }).click();
    await expect(win.getByTestId('provider-add')).toBeVisible();
    await check(win, 'Setup 4 · Providers, add form');
    await win.getByRole('button', { name: 'Add a key to the Vault' }).click();
    await expect(win.getByTestId('setup-vault')).toBeVisible();
    await check(win, 'Setup 4 · Providers, Vault');
    await win.getByRole('button', { name: 'Skip for now' }).click();

    await expect(step).toContainText('Step 5 of 9');
    await check(win, 'Setup 5 · About you');
    await win.getByRole('button', { name: 'Skip this question' }).click();
    await expect(win.getByText('Skipped')).toHaveCount(1);
    await check(win, 'Setup 5 · About you, one skipped');
    await win.getByRole('button', { name: 'Skip for now' }).click();

    await expect(step).toContainText('Step 6 of 9');
    await check(win, 'Setup 6 · First project');
    await win.getByRole('button', { name: 'Later' }).click();

    await expect(step).toContainText('Step 7 of 9');
    await check(win, 'Setup 7 · Safety');
    await win.getByRole('button', { name: 'Skip for now' }).click();

    await expect(step).toContainText('Step 8 of 9');
    await check(win, 'Setup 8 · First goal');
    await win.getByRole('button', { name: "Skip: I'll give the Queen my own goal" }).click();

    await expect(step).toHaveText('Step 9 of 9 · Done');
    await check(win, 'Setup 9 · Done');
    await win.getByRole('button', { name: 'Open the hive' }).click();

    // The shell with no project yet.
    await expect(win.getByRole('heading', { name: 'Choose a project for the hive' })).toBeVisible({ timeout: 15_000 });
    await check(win, 'Queen · no project yet');
    await open(win, 'Cadence');
    await check(win, 'Cadence · no project yet');
  } finally {
    await t.close();
  }
  expect(serious, serious.join('\n')).toEqual([]);
});

test('panels, forms, detail views and dialogs pass axe in both themes', async () => {
  test.setTimeout(240_000);
  const t = await launchApp({ env: { INSECTOIDS_E2E_BRAIN_SEED: '1', INSECTOIDS_E2E_FAKE_INSTALL: 'ok' } });
  try {
    const { win } = t;
    // A smaller window, like CI screens: narrow layouts scroll sideways, and those regions must be keyboard-reachable.
    await t.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1024, 720));
    await expect(win.getByLabel('Message the Queen')).toBeEnabled({ timeout: 30_000 });
    await expect(win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    expect(await command(win, { type: 'setManagers', scoutBeforePlanning: false })).toEqual({ ok: true });
    expect(await command(win, { type: 'submitGoal', text: 'Say hello from the hive' })).toEqual({ ok: true });
    await expect.poll(async () => (await snapshot(win)).approvals.some((a) => a.status === 'waiting'), { timeout: 30_000 }).toBe(true);
    expect(
      await command(win, {
        type: 'createCadence',
        cadence: { name: 'Weekly report', when: { type: 'weekly', days: [1], time: '09:00' }, goal: 'Write the weekly status report', budgetTokens: 150_000, autonomy: 'small-plans', enabled: true },
      }),
    ).toEqual({ ok: true });
    expect(
      await command(win, {
        type: 'createCadence',
        cadence: { name: 'Inbox hook', when: { type: 'webhook' }, goal: 'Look at what the outside app sent and tidy up', budgetTokens: 50_000, autonomy: 'small-plans', enabled: true },
      } as Parameters<HiveApi['command']>[0]),
    ).toEqual({ ok: true });

    // Queen: the goal with its plan waiting (inline approval card).
    await open(win, 'Queen');
    const goal = win.getByRole('article', { name: /Goal:/ });
    await expect(goal.getByTestId('plan')).toContainText('Write hello.txt', { timeout: 30_000 });
    await expect(goal.locator('[data-approval-id]').first()).toBeVisible();
    await check(win, 'Queen · plan waits for approval');

    // Approvals: the plan selected.
    await open(win, 'Approvals');
    await win.getByRole('list', { name: 'Approvals' }).getByRole('button').first().click();
    await expect(win.locator('[data-approval-id]').first()).toBeVisible();
    await check(win, 'Approvals · item selected');

    // Cadence: the new-cadence form, with each kind of "When", and its problems in words.
    await open(win, 'Cadence');
    await win.getByRole('button', { name: 'New cadence' }).first().click();
    const form = win.getByTestId('cadence-form');
    await expect(form).toBeVisible();
    for (const when of ['Every few minutes or hours', 'On days of the week', 'When files change in a folder', 'When something happens in the hive', 'A webhook is called']) {
      await form.getByRole('radio', { name: when }).click();
      await check(win, `Cadence · new form · ${when}`);
    }
    await form.getByRole('button', { name: 'Create cadence' }).click();
    await expect(form.getByText('Give the cadence a name.')).toBeVisible();
    await check(win, 'Cadence · new form · problems');
    await form.getByRole('button', { name: 'Cancel' }).click();
    await expect(form).toHaveCount(0);

    // A built-in job's runs (Run now the backup, so a run and a backup exist), then its schedule editor.
    const backupRow = win.getByTestId('housekeeping-row').filter({ hasText: MAINTENANCE_JOBS.backup.name });
    await backupRow.getByRole('button', { name: 'Run now' }).click();
    await expect.poll(async () => (await snapshot(win)).cadences.find((c) => c.id === 'maint-backup')?.lastRun?.outcome, { timeout: 30_000 }).toBe('done');
    await backupRow.getByRole('button', { name: 'Runs' }).click();
    await expect(win.getByTestId('cadence-history').getByTestId('cadence-run').first()).toBeVisible({ timeout: 10_000 });
    await check(win, 'Cadence · Housekeeping runs');
    await backupRow.getByRole('button', { name: 'Change schedule' }).click();
    await expect(win.getByTestId('schedule-editor')).toBeVisible();
    await check(win, 'Cadence · Housekeeping schedule editor');
    await win.getByTestId('schedule-editor').getByRole('button', { name: 'Cancel' }).click();

    // A user cadence's runs, and a webhook cadence's panel with the "new secret" confirm open.
    const weekly = win.getByTestId('cadence-row').filter({ hasText: 'Weekly report' });
    await weekly.getByRole('button', { name: 'Runs' }).click();
    await expect(win.getByTestId('cadence-history')).toBeVisible();
    await check(win, 'Cadence · runs pane (no runs yet)');
    const hook = win.getByTestId('cadence-row').filter({ hasText: 'Inbox hook' });
    await hook.getByRole('button', { name: 'Runs' }).click();
    const panel = win.getByTestId('webhook-panel');
    await expect(panel.getByTestId('webhook-run-url')).toContainText('127.0.0.1', { timeout: 10_000 });
    await check(win, 'Cadence · webhook panel');
    const newSecret = panel.getByRole('button', { name: 'New secret' });
    if (await newSecret.isEnabled()) {
      await newSecret.click();
      await expect(panel.getByTestId('webhook-new-secret-confirm')).toBeVisible();
      await check(win, 'Cadence · webhook panel, new secret confirm');
      await panel.getByRole('button', { name: 'Keep the old one' }).click();
    }

    // Both digests: folded open on the Cadence screen, and the dialog from the top bar.
    await win.getByTestId('cadence-digest-toggle').click();
    await expect(win.getByTestId('cadence-digest')).toBeVisible();
    await check(win, 'Cadence · digest open');
    await win.getByTestId('cadence-digest-toggle').click();
    const away = win.getByRole('dialog', { name: 'While you were away' });
    await checkDialog(win, 'Dialog · While you were away', win.getByTestId('away-digest-button'), away, 'Close');

    // Settings: the backups, and the restore confirm (cancelled).
    await open(win, 'Settings');
    const backups = win.getByTestId('backups');
    await backups.scrollIntoViewIfNeeded();
    const restore = backups.getByTestId('backup-row').first().getByRole('button', { name: 'Restore' });
    await expect(restore).toBeVisible({ timeout: 15_000 });
    await check(win, 'Settings · backups');
    await checkDialog(win, 'Dialog · Restore this backup?', restore, win.getByRole('dialog', { name: 'Restore this backup?' }), 'Keep my Brain');

    // Brain: a record's detail, its editor, and the other views.
    await open(win, 'Brain');
    const views = win.getByRole('tablist', { name: 'Brain view' });
    await views.getByRole('tab', { name: 'Notes' }).click();
    await win.getByTestId('brain-search').fill('Order page progress');
    await win.getByTestId('brain-hit').first().click();
    const reader = win.getByTestId('brain-reader');
    await expect(reader.getByRole('heading').first()).toBeVisible({ timeout: 10_000 });
    await check(win, 'Brain · record detail');
    await reader.getByTestId('record-edit').click();
    await expect(reader.getByTestId('record-editor')).toBeVisible();
    await check(win, 'Brain · record editor');
    await reader.getByTestId('record-editor').getByRole('button', { name: 'Cancel' }).click();
    for (const view of ['Graph', 'Code']) {
      await views.getByRole('tab', { name: view }).click();
      await win.waitForTimeout(800);
      await check(win, `Brain · ${view} view`);
    }

    // Library: the castes, and an item's detail with its full text.
    await open(win, 'Library');
    await win.getByTestId('library-tab-castes').click();
    await expect(win.getByTestId('caste-card').first()).toBeVisible();
    await check(win, 'Library · castes');
    await win.getByTestId('library-tab-catalog').click();
    await win.getByTestId('library-row').first().click();
    const detail = win.getByTestId('library-detail');
    await expect(detail.getByRole('heading').first()).toBeVisible({ timeout: 10_000 });
    await check(win, 'Library · item detail');
    const full = detail.getByRole('button', { name: 'Read the full text' });
    if (await full.count()) {
      await full.click();
      await expect(detail.getByTestId('library-text')).not.toBeEmpty();
      await check(win, 'Library · item full text');
    }

    // Connections: every tab, the add-provider form, and the install dialog (opened, never run).
    await open(win, 'Connections');
    const tabs = win.getByRole('tablist', { name: 'Connections' });
    await tabs.getByRole('tab', { name: /^API providers/ }).click();
    await expect(win.getByTestId('providers-tab')).toBeVisible();
    await check(win, 'Connections · providers');
    await win.getByTestId('providers-tab').getByRole('button', { name: 'Add a provider' }).click();
    await expect(win.getByTestId('provider-add')).toBeVisible();
    await check(win, 'Connections · providers, add form');
    for (const name of ['Vault', 'Services']) {
      await tabs.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
      await win.waitForTimeout(400);
      await check(win, `Connections · ${name}`);
    }
    await tabs.getByRole('tab', { name: /^Engines/ }).click();
    const install = win.getByTestId('engine-install').first();
    if (await install.isVisible().catch(() => false)) {
      await checkDialog(win, 'Dialog · install an engine', install, win.getByTestId('install-dialog'), 'Close');
    }

    // The goal running: approve the plan, then the Queen's goal detail, a Taskboard card, the Hive views and a
    // decided approval.
    const plan = (await snapshot(win)).approvals.find((a) => a.status === 'waiting' && a.kind === 'plan')!;
    expect(await command(win, { type: 'approve', approvalId: plan.id })).toEqual({ ok: true });
    await open(win, 'Queen');
    await expect(win.getByTestId('goal-progress')).toBeVisible({ timeout: 30_000 });
    await check(win, 'Queen · goal running (detail)');
    await open(win, 'Taskboard');
    const card = win.getByRole('button', { name: /wave 1\.$/ }).first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.click();
    await expect(win.getByRole('complementary', { name: 'Card details' })).toBeVisible();
    await check(win, 'Taskboard · card detail');
    await open(win, 'Hive');
    await check(win, 'Hive · lanes, goal running');
    await win.getByTestId('hive-view-living').click();
    await win.waitForTimeout(600);
    await check(win, 'Hive · living hive');
    await open(win, 'Approvals');
    await check(win, 'Approvals · with a decided item');
  } finally {
    await t.close();
  }
  expect(serious, serious.join('\n')).toEqual([]);
});
