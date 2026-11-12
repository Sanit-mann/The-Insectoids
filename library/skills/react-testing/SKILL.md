---
name: react-testing
description: Behavior-first tests for React components and hooks with Testing Library, Vitest or Jest, user-event, network-level mocking (MSW) and axe accessibility checks, plus when to move to real-browser component tests or end-to-end tests. Use when writing, fixing or reviewing tests for React components, hooks, forms or pages, or setting up a React test stack.
metadata:
  kind: skill
  castes: [tester, coder, reviewer]
  tags: [react, testing, vitest, jest, testing-library]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: skills/react-testing/SKILL.md
      license: MIT
---

# React Testing

Test what the user sees and does, not how the component is built. Full code examples: [references/examples.md](references/examples.md).

## When to use

- Writing or fixing tests for components, custom hooks, forms or pages.
- Adding coverage to untested components, or migrating away from Enzyme-style tests.
- Setting up the runner, network mocking or shared providers.
- Deciding whether a test belongs in a DOM-emulated test, a real-browser component test or end-to-end.

Pair with `test-driven-development` for the red-green-refactor loop and `e2e-testing` for full user flows.

## Core principle

A good test:
- renders the component with the same providers it has in production;
- interacts through accessible queries and realistic user events;
- asserts visible output and observable effects (callback called, request sent, text shown).

A good test does not inspect state, props passed to children, hook calls, render counts or DOM structure that users cannot perceive.

## Choose the runner

| Runner | When |
|---|---|
| Vitest | Vite-based or modern ESM setups; Jest-compatible API |
| Jest | Existing Jest repos and setups built around it |
| Real-browser component testing (Vitest browser mode, Playwright CT, Cypress CT) | Layout, real CSS, browser APIs the DOM emulator lacks |

Use what the repo already has. Do not add a second unit runner without a clear split of responsibilities.

## Queries

Use in this order:
1. `getByRole` (with `{ name }`), `getByLabelText`, `getByPlaceholderText`, `getByText`, `getByDisplayValue`
2. `getByAltText`, `getByTitle`
3. `getByTestId`, only as a last resort

- `getBy*` throws when missing; `queryBy*` returns `null` (use it to assert absence); `findBy*` waits (use it for content that appears after async work).
- Query from `screen`, not from `container`.
- If an element cannot be found by role or label, that is often an accessibility bug in the component. Fix the component.

## Interaction

- Use `user-event`: `const user = userEvent.setup()` once per test, then `await user.click(...)`, `await user.type(...)`. Always await.
- `fireEvent` dispatches one synthetic event; reserve it for events user-event cannot produce.

## Async

- Wait with `findBy*`, `waitFor(() => expect(...))` or `waitForElementToBeRemoved`. Never `setTimeout` plus an assertion.
- Keep `waitFor` callbacks to assertions only; no side effects inside.
- Treat `act(...)` warnings as bugs (an unawaited update, or an update after unmount).
- With fake timers, tell user-event to advance them (`advanceTimers` option).

## Network mocking

- Mock at the network layer (MSW) so components, hooks and the fetch client run as in production.
- Start the server with `onUnhandledRequest: 'error'` so unmocked calls fail loudly. Reset handlers after each test.
- Override per test with `server.use(...)` for error, empty and slow cases.
- Do not mock the fetch client or data hooks module unless there is no network seam.

## Providers

- Write one `renderWithProviders` helper (router, query client, theme, i18n) in a shared test-utils file.
- Create a **fresh** query client per test with retries off, so cache and retries do not leak between tests.

## Hooks

- Prefer testing a hook through a component that uses it. Use `renderHook` for reusable hooks with a public API.
- Wrap direct state-changing calls in `act`. Pass a `wrapper` for hooks that need context.
- Assert through the hook's return value only.

## Accessibility checks

- Run axe (`jest-axe` or `vitest-axe`) on every interactive component. It catches missing labels, invalid ARIA, missing alt text and heading order.
- DOM emulators have no layout or real CSS, so contrast and focus visibility need a real browser.
- More: `accessibility` skill.

## Snapshots

Avoid DOM snapshots of components: they break on every markup change, get approved without reading and assert structure, not behavior. Snapshots are fine for stable serialized output (formatters, generated config). For visual regressions, use screenshot comparison in a real browser.

## When to leave the DOM emulator

jsdom and happy-dom cannot do real layout, CSS transitions, scrolling, drag-and-drop, clipboard, iframes, popups, downloads or cross-origin flows.

| What you test | Where |
|---|---|
| Hook, presentational component, form logic | Testing Library in the unit runner |
| Layout-dependent component, browser APIs missing from jsdom | Real-browser component test |
| Multi-page user flow, auth, payments | End-to-end |
| Async Server Components | End-to-end (as of 2025, Testing Library and unit runners do not render async Server Components); unit-test their data functions separately |

## Coverage

- Coverage proves code ran, not that behavior is right. Cover golden paths, error states, empty states and edge cases first.
- Follow the project's thresholds. A common baseline: about 80% lines/functions/statements and 70% branches. Aim higher for pure utilities and hooks.
- Pages get a smoke test plus end-to-end coverage.

## Anti-patterns

- `container.querySelector(...)` or class-name selectors.
- Asserting render counts, internal state or which child received which prop.
- Mocking React or its hooks; mocking child components by default (mock only children with heavy side effects).
- Shared mutable state between tests; order-dependent tests.
- Ignored `act` warnings or console errors.
- A test that still passes when the behavior it names is deleted: it asserts nothing useful. Check by breaking the code once.

## Commands

Run with the terminal tool, using the project's scripts if present:
- Vitest: `vitest` (watch), `vitest run`, `vitest run --coverage`, `vitest run path/to/file.test.tsx`
- Jest: `jest --watch`, `jest --coverage`, `jest path/to/file.test.tsx`

## Done when

- Each new behavior has a test that failed before the change and passes after.
- Tests use role or label queries and user-event; no implementation-detail assertions.
- Unhandled network requests fail the suite; no `act` warnings in the output.
- Interactive components pass an axe check.
