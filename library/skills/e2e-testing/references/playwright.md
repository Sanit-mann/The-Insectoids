# Playwright Test reference

Detail for the `e2e-testing` skill. Adapt names and paths to the project's existing layout.

## Layout

```
tests/
  e2e/
    auth/login.spec.ts
    features/search.spec.ts
    auth.setup.ts          # logs in once, saves storage state
  pages/                   # page objects
    ItemsPage.ts
  fixtures/
    data.ts                # test data builders
playwright.config.ts
```

## Config

```typescript
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['junit', { outputFile: 'playwright-results.xml' }],
  ],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'playwright/.auth/user.json' },
      dependencies: ['setup'],
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], storageState: 'playwright/.auth/user.json' },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
```

Add Firefox and WebKit projects if the product supports them. Add `playwright/.auth/` to `.gitignore`: storage state contains session cookies.

## Auth setup (log in once)

```typescript
// tests/e2e/auth.setup.ts
import { test as setup, expect } from '@playwright/test'

setup('authenticate', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill(process.env.E2E_USER!)
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD!)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page).toHaveURL(/dashboard/)
  await page.context().storageState({ path: 'playwright/.auth/user.json' })
})
```

`E2E_USER` / `E2E_PASSWORD` are a seeded test account, supplied by env or CI secrets.

## Page object

```typescript
import { type Page, type Locator, expect } from '@playwright/test'

export class ItemsPage {
  readonly search: Locator
  readonly results: Locator
  readonly empty: Locator

  constructor(readonly page: Page) {
    this.search = page.getByRole('searchbox', { name: 'Search items' })
    this.results = page.getByTestId('item-card')
    this.empty = page.getByText('No items found')
  }

  async goto() {
    await this.page.goto('/items')
    await expect(this.search).toBeVisible()
  }

  async searchFor(query: string) {
    const response = this.page.waitForResponse(
      r => r.url().includes('/api/search') && r.ok(),
    )
    await this.search.fill(query)
    await this.search.press('Enter')
    await response
  }
}
```

Keep assertions about outcomes in the test; page objects may assert readiness.

## Test

```typescript
import { test, expect } from '@playwright/test'
import { ItemsPage } from '../pages/ItemsPage'

test.describe('Item search', () => {
  test('finds items by keyword', async ({ page }) => {
    const items = new ItemsPage(page)
    await items.goto()
    await items.searchFor('lamp')
    await expect(items.results.first()).toContainText(/lamp/i)
  })

  test('shows empty state for no results', async ({ page }) => {
    const items = new ItemsPage(page)
    await items.goto()
    await items.searchFor('zzz-no-match-123')
    await expect(items.empty).toBeVisible()
    await expect(items.results).toHaveCount(0)
  })
})
```

## Test data

- Create data through the API or a seed helper in `beforeEach`, with unique names (`item-${Date.now()}-${test.info().workerIndex}`).
- Delete it in `afterEach`, or use a disposable tenant/database per run.
- Never depend on data another test created.

## Mocking third parties

```typescript
await page.route('**/api.payments.example/**', route =>
  route.fulfill({ status: 200, json: { status: 'succeeded', id: 'test_123' } }),
)
```

Only mock services you do not own. For browser-injected providers (for example a crypto wallet), use `context.addInitScript` to install a fake provider object before page scripts run.

## Guarding dangerous flows

```typescript
test('places an order', async ({ page }) => {
  test.skip(process.env.TARGET_ENV === 'production', 'Never place real orders')
  // ...
})
```

## Quarantine

```typescript
test('filters by date range', async ({ page }) => {
  test.fixme(true, 'Flaky: https://tracker.example/ISSUE-123')
})

test('exports CSV @flaky', async ({ page }) => { /* ... */ })
// Blocking job:     npx playwright test --grep-invert @flaky
// Non-blocking job: npx playwright test --grep @flaky
```

## Artifacts

- Element or page screenshot inside a test: `await page.getByTestId('chart').screenshot({ path: 'artifacts/chart.png' })`.
- Traces come from `trace: 'on-first-retry'` in config; open with `npx playwright show-trace`.
- Visual comparison: `await expect(page).toHaveScreenshot('home.png', { maxDiffPixelRatio: 0.01 })`. Baselines are committed; update only on purpose with `--update-snapshots`, and review the diff.

## CI (GitHub Actions example)

```yaml
name: e2e
on: [pull_request]
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npx playwright test
        env:
          BASE_URL: ${{ vars.PREVIEW_URL }}
          E2E_USER: ${{ secrets.E2E_USER }}
          E2E_PASSWORD: ${{ secrets.E2E_PASSWORD }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 14
```

Pin action versions (or commit SHAs) to the project's policy. Shard large suites with `--shard=1/4` across a matrix.

## Report template (for the task card)

```markdown
# E2E report - <date>
Status: PASSING | FAILING   Duration: <m s>   Target: <URL>
Total <n> | Passed <n> | Failed <n> | Flaky <n> | Skipped/quarantined <n>

## Failures
### <test title>
File: tests/e2e/<file>.spec.ts:<line>
Error: <assertion message>
Artifacts: <trace / screenshot / video paths>
Likely cause and fix: <one or two lines>

## Quarantined
- <test> - <issue link> - since <date>

## Coverage gaps
- <journey not covered and why>
```
