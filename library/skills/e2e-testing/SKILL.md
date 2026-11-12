---
name: e2e-testing
description: Write, run and maintain end-to-end browser tests for critical user journeys - risk-based journey selection, stable user-facing selectors, condition-based waits, isolated test data, artifacts on failure, and flaky-test detection and quarantine. Playwright Test by default. Use when adding or fixing E2E tests, triaging flaky runs, or wiring E2E into CI.
metadata:
  kind: skill
  castes: [tester, coder]
  tags: [testing, e2e, playwright, ci]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: skills/e2e-testing/SKILL.md
      license: MIT
    - repo: affaan-m/ecc
      path: agents/e2e-runner.md
      license: MIT
---

# E2E Testing

E2E tests are the last line of defense: they prove the real app works for a user across browser, frontend, API and data. They are slow and costly, so test the journeys that matter and make every test stable.

**Use when:** a card asks for E2E coverage, a critical flow changed, an E2E run is failing or flaky, or CI needs an E2E stage.
**Not for:** logic that a unit or component test can cover (test it there); one-off exploratory checks (`web-app-qa`).

Framework detail (config, page objects, auth setup, CI, report template): [references/playwright.md](references/playwright.md). If the project already uses another runner (Cypress, WebdriverIO), follow its conventions and apply the same rules.

## 1. Plan the journeys

1. List the critical user journeys: sign-up/login, the core create-read-update-delete flow, search, checkout or payment, onboarding.
2. Rank by risk: **high** (money, auth, data loss), **medium** (search, navigation), **low** (UI polish, usually not E2E).
3. For each journey, define happy path, main error path (invalid input, server error) and one edge case.
4. Check what already exists. Extend the suite; do not duplicate it.

Tip: walk the flow once in a browser (`browser-automation`) to learn the real labels, roles and URLs before writing the test.

## 2. Write stable tests

**Selectors, in order of preference:**
1. User-facing roles and labels: `getByRole('button', { name: 'Save' })`, `getByLabel('Email')`, `getByText` for static copy. These also catch accessibility regressions.
2. A test id (`getByTestId('cart-total')`) when there is no stable accessible name. Add the attribute to the app if needed.
3. CSS only as a last resort. Never XPath, nth-child chains or generated class names.

**Waiting:**
- Use auto-waiting locators and web-first assertions: `await expect(locator).toBeVisible()`, `toHaveText`, `toHaveURL`.
- Wait for a specific response when the UI depends on it: `page.waitForResponse(r => r.url().includes('/api/search') && r.ok())`.
- Never `waitForTimeout` / sleep. Avoid `networkidle` as a general wait; it is unreliable with polling, sockets and analytics.

**Structure:**
- One journey per test, readable as a user story. Assert at every key step, not only at the end.
- Page objects (or small helper functions) hold locators and actions; tests hold the story and assertions.
- Each test is independent: its own data (created through the API or seed, unique names), no ordering assumptions, no shared mutable state. Clean up or use disposable data.
- Log in once in a setup step and reuse the saved storage state, instead of typing credentials in every test.
- Mock only third parties you do not own (payment providers, email, maps) with request routing. Do not mock your own backend in E2E; that is what makes it end-to-end.

## 3. Run and harden

```bash
npx playwright test                          # whole suite
npx playwright test tests/e2e/auth/login.spec.ts
npx playwright test --repeat-each=10 <file>  # flake check for a new or changed test
npx playwright test --headed / --debug       # watch or step through locally
npx playwright show-report                   # HTML report
npx playwright show-trace <trace.zip>        # step-by-step replay of a failure
```

- Before handing off, run each new or changed test at least 3-5 times (or `--repeat-each=10`). It must pass every time.
- Run against the browsers the project supports (Chromium plus WebKit/Firefox or a mobile profile if configured).
- Keep traces, screenshots and video **on failure or first retry** only.

## 4. Flaky tests

A test that sometimes fails is a bug in the test or the app. Do not hide it with longer timeouts.

**Detect:** `--repeat-each`, CI retry reports (a test that passed on retry is marked flaky), history across runs.

**Common causes and fixes:**

| Cause | Fix |
|---|---|
| Acting before the element is ready | Use locators and web-first assertions, not raw element handles |
| Racing the network | Wait for the specific response or the UI result it produces |
| Animations, transitions | Assert the final state; disable animations in test config or via reduced motion |
| Shared or leftover data | Unique data per test; reset through API or seed |
| Order dependence | Run single tests alone and the suite with `--fully-parallel` to expose it |
| Time, timezone, locale | Fix the clock, timezone and locale in config |
| Third-party slowness | Route and mock the third party |

**Quarantine (when a fix is not immediate):**
1. Mark it so it no longer blocks the pipeline: `test.fixme(true, 'Flaky: <issue link>')`, or tag `@flaky` and run tagged tests in a separate non-blocking job.
2. Open an issue with the failure trace and the suspected cause; link it in the test.
3. Quarantine is temporary. Fix or delete within the agreed window (for example two weeks). Never quarantine a high-risk journey silently: report it on the card as a coverage gap.

## 5. CI

- Install browsers in CI with the package's install command (`npx playwright install --with-deps`) at the version pinned in the lockfile.
- `forbidOnly` in CI, retries 2 in CI and 0 locally, so flakiness is visible.
- Upload the HTML report and failure artifacts on every run, even when green.
- Point tests at a preview or staging URL through an environment variable, never production.

## Safety

- Never run tests that move real money, send real messages or delete real data against production. Guard such tests with an environment check that skips them on production.
- Test credentials and seed data only; keep them in env vars or fixture files, never hard-coded real secrets.
- Artifacts (traces, videos, screenshots) can contain tokens and personal data; keep them in CI storage with retention limits.

## Targets

- Critical journeys: 100% passing.
- Overall pass rate > 95%, flaky rate < 5%.
- Suite time < 10 minutes (shard or parallelize when it grows).

## Done when

- Each new or changed test passes repeatedly, uses role/label or test-id selectors, and has no sleeps.
- Failure artifacts are configured and the report is reachable.
- The task card lists: journeys covered, results (pass/fail/flaky/skipped counts), any quarantined tests with issue links, and remaining gaps. Use the report template in the reference.
