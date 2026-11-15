import AxeBuilder from '@axe-core/playwright';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, expect, test } from '@playwright/test';
import type { HiveApi } from '@insectoids/shared';
import { type LaunchedApp, launchApp } from './support/launch';

/**
 * Accessibility (WCAG 2.2 AA; Phase 3 C1): an automated axe check of every screen in both themes, with real
 * content on screen (a goal waiting for its plan approval, a cadence, the built-in jobs).
 *
 * Serious and critical findings fail the test. Every finding (any impact) is written to
 * `test-results/axe-report.json` so moderate and minor ones can be read and fixed too.
 */
const SCREENS = ['Queen', 'Approvals', 'Taskboard', 'Hive', 'Brain', 'Changes', 'Library', 'Connections', 'Budgets', 'Cadence', 'Settings'] as const;
const THEMES = ['dark', 'light'] as const;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

type Win = { insectoids: { hive: HiveApi } };
interface Finding {
  theme: string;
  screen: string;
  id: string;
  impact: string | null;
  help: string;
  nodes: Array<{ target: string; summary: string }>;
}

test.describe.configure({ mode: 'serial' });

let t: LaunchedApp;
const findings: Finding[] = [];

test.beforeAll(async () => {
  t = await launchApp();
  const { win } = t;
  // A smaller window, like CI screens: narrow layouts scroll sideways, and those regions must be keyboard-reachable.
  await t.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1024, 720));
  // Content worth checking: a goal whose plan waits for approval, and a cadence.
  await expect(win.getByLabel('Message the Queen')).toBeEnabled({ timeout: 30_000 });
  expect(await win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.command({ type: 'submitGoal', text: 'Say hello from the hive' }))).toEqual({ ok: true });
  await expect
    .poll(async () => (await win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.snapshot())).approvals.some((a) => a.status === 'waiting'), { timeout: 30_000 })
    .toBe(true);
  expect(
    await win.evaluate(() =>
      (globalThis as unknown as Win).insectoids.hive.command({
        type: 'createCadence',
        cadence: { name: 'Weekly report', when: { type: 'weekly', days: [1], time: '09:00' }, goal: 'Write the weekly status report', budgetTokens: 150_000, autonomy: 'small-plans', enabled: true },
      }),
    ),
  ).toEqual({ ok: true });
});

test.afterAll(async () => {
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'test-results', 'axe-report.json'), `${JSON.stringify(findings, null, 2)}\n`);
  await t?.close();
});

async function setTheme(win: Page, theme: (typeof THEMES)[number]): Promise<void> {
  const toggle = win.getByRole('button', { name: /^Switch to (dark|light) theme$/ });
  if ((await toggle.getAttribute('aria-label')) === `Switch to ${theme} theme`) await toggle.click();
  await expect(win.locator('html')).toHaveAttribute('data-theme', theme);
}

async function scan(win: Page, theme: string, screen: string): Promise<Finding[]> {
  // Legacy mode: Electron can't open the extra page AxeBuilder normally uses to check frames (the app has none).
  const r = await new AxeBuilder({ page: win }).setLegacyMode(true).withTags(TAGS).analyze();
  return r.violations.map((v) => ({
    theme,
    screen,
    id: v.id,
    impact: v.impact ?? null,
    help: v.help,
    nodes: v.nodes.slice(0, 8).map((n) => ({ target: n.target.join(' '), summary: (n.failureSummary ?? '').split('\n').slice(0, 3).join(' ') })),
  }));
}

for (const theme of THEMES) {
  test(`every screen passes axe (WCAG 2.2 AA) in the ${theme} theme`, async () => {
    test.setTimeout(180_000);
    const { win } = t;
    await setTheme(win, theme);
    const serious: string[] = [];
    for (const screen of SCREENS) {
      await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${screen}`) }).click();
      await expect(win.getByRole('heading', { level: 1, name: screen })).toBeVisible({ timeout: 15_000 });
      // Let lazy content and animations settle.
      await win.waitForTimeout(600);
      const found = await scan(win, theme, screen);
      findings.push(...found);
      for (const f of found) if (f.impact === 'serious' || f.impact === 'critical') serious.push(`${screen}: ${f.id} (${f.impact}) ${f.help} → ${f.nodes.map((n) => n.target).join(', ')}`);
    }
    expect(serious, serious.join('\n')).toEqual([]);
  });
}
