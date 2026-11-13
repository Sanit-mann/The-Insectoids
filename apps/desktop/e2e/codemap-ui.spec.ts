import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp, repoGit } from './support/launch';

/**
 * The code map on the Brain screen (Phase 2 B4): the status strip, Rebuild, looking up a symbol, its file
 * outline and who calls it, and the no-project state. The project gets its own small TypeScript and Python
 * files here, so the spec doesn't depend on any seed.
 */
let launched: LaunchedApp;

const openCode = async (win: Page): Promise<void> => {
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Brain' }).click();
  await win.getByTestId('brain-view-switch').getByRole('tab', { name: 'Code' }).click();
};

test.describe('with a project', () => {
  test.beforeAll(async () => {
    launched = await launchApp();
    const { repo, win } = launched;
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(
      join(repo, 'src', 'greet.ts'),
      [
        '/** Says hello to someone by name. */',
        'export function greet(name: string): string {',
        '  return `Hello, ${formatName(name)}!`;',
        '}',
        '',
        'function formatName(name: string): string {',
        '  return name.trim();',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(join(repo, 'src', 'app.ts'), ["import { greet } from './greet';", '', 'export function main(): void {', "  console.log(greet('Ada'));", '}', ''].join('\n'));
    writeFileSync(join(repo, 'tools.py'), ['def shout(text):', '    """Upper-case the text."""', '    return text.upper()', ''].join('\n'));
    repoGit(repo, 'add', '-A');
    repoGit(repo, 'commit', '-q', '-m', 'Add code for the map');
    await expect(win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
    await openCode(win);
  });

  test.afterAll(async () => {
    await launched?.close();
  });

  test('Rebuild maps the project and the strip shows what it found', async () => {
    const { win } = launched;
    const status = win.getByTestId('codemap-status');
    await expect(status).toBeVisible();
    await expect(status).toContainText('without AI');
    await status.getByRole('button', { name: /Rebuild/ }).click();
    await expect(status).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await expect(win.getByTestId('codemap-counts')).toContainText(/\d+ files? · \d+ symbols?/);
    await expect(status.getByRole('list', { name: 'Languages' })).toContainText('TypeScript');
    await expect(win.getByTestId('codemap-counts')).toContainText('Last built');
  });

  test('a symbol shows its signature, its file outline and who calls it', async () => {
    const { win } = launched;
    await expect(win.getByTestId('codemap-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await win.getByTestId('codemap-search').fill('greet');
    const hit = win.getByTestId('codemap-hit').filter({ hasText: 'src/greet.ts' }).first();
    await expect(hit).toBeVisible({ timeout: 10_000 });
    await expect(hit.getByTestId('codemap-kind')).toHaveText('function');
    await hit.click();

    const detail = win.getByTestId('codemap-detail');
    await expect(detail.getByTestId('codemap-signature')).toContainText('greet(name: string)');
    await expect(detail).toContainText('Says hello to someone by name.');
    const outline = detail.getByTestId('codemap-outline');
    await expect(outline).toContainText('formatName', { timeout: 10_000 });
    await expect(detail.getByTestId('codemap-callers')).toContainText('main', { timeout: 10_000 });
    await expect(detail.getByTestId('codemap-callees')).toContainText('formatName', { timeout: 10_000 });
  });

  test('the mode switch moves with the arrow keys and Callers lists the calls', async () => {
    const { win } = launched;
    const modes = win.getByRole('radiogroup', { name: 'Look up' });
    await modes.getByRole('radio', { name: 'Symbols' }).click();
    await win.keyboard.press('ArrowRight');
    await expect(modes.getByRole('radio', { name: 'Files' })).toHaveAttribute('aria-checked', 'true');
    await win.keyboard.press('ArrowRight');
    await expect(modes.getByRole('radio', { name: 'Callers' })).toHaveAttribute('aria-checked', 'true');
    await win.getByTestId('codemap-search').fill('greet');
    await expect(win.getByTestId('codemap-hit').filter({ hasText: 'main' }).first()).toBeVisible({ timeout: 10_000 });
  });

  test('Python files are mapped too', async () => {
    const { win } = launched;
    await win.getByRole('radiogroup', { name: 'Look up' }).getByRole('radio', { name: 'Symbols' }).click();
    await win.getByTestId('codemap-search').fill('shout');
    const hit = win.getByTestId('codemap-hit').filter({ hasText: 'tools.py' }).first();
    await expect(hit).toBeVisible({ timeout: 10_000 });
    await expect(hit).toContainText('Upper-case the text.');
  });

  test('switching back to Notes keeps the Brain search', async () => {
    const { win } = launched;
    await win.getByTestId('brain-view-switch').getByRole('tab', { name: 'Notes' }).click();
    await expect(win.getByTestId('brain-search')).toBeVisible();
    await openCode(win);
  });
});

test('without a project, the code map points to the Queen screen', async () => {
  const none = await launchApp({ project: 'none' });
  try {
    await expect(none.win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
    await openCode(none.win);
    const empty = none.win.getByTestId('codemap-no-project');
    await expect(empty).toBeVisible();
    await empty.getByRole('button', { name: 'Go to the Queen screen' }).click();
    await expect(none.win.getByRole('heading', { name: 'Choose a project for the hive' })).toBeVisible();
  } finally {
    await none.close();
  }
});
