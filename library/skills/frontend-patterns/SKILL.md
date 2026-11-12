---
name: frontend-patterns
description: Framework-neutral frontend architecture decisions - where state lives, server-state fetching and caching, loading/error/empty states, forms and validation, routing and URL state, styling approach, code splitting, client-side security. Use when planning, building or reviewing UI architecture in any framework. For React component and hook rules, load react-patterns instead.
metadata:
  kind: skill
  castes: [coder, reviewer]
  tags: [frontend, architecture, state, forms, routing, styling]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: skills/frontend-patterns/SKILL.md
      license: MIT
---

# Frontend Patterns

Decide where each piece of state lives, how data reaches the screen, and how the UI behaves while it waits or fails. These decisions hold in React, Vue, Svelte, Angular, Solid or plain web components. Framework-specific code lives in that framework's skill (for React: `react-patterns`, `react-performance`, `react-testing`).

## When to use

- Starting a feature or app and choosing state, data-fetching, form, routing or styling approaches.
- Reviewing UI code for state duplication, fetch races, missing loading or error states, or broken back-button behavior.
- A screen is hard to change because data flows in several directions.

## 1. Classify state first

Every value belongs to exactly one category. Most bugs come from storing one kind as another.

| Kind | Examples | Lives in |
|---|---|---|
| Server state | records, lists, user profile | A server-state cache (query library, framework loader). Never copied into a global store. |
| URL state | filters, sort, page, selected tab, search text | Path and query params |
| Form state | field values, touched, errors | The form (native or form library) until submit |
| Local UI state | open/closed, hover, step of a wizard | The component that owns it |
| Shared client state | theme, auth session, cart before checkout | A small store or context with narrow selectors |
| Persistent preferences | dismissed banners, layout choice | Storage (versioned), mirrored into state on load |
| Derived state | totals, filtered lists, `isValid` | Computed from the above; never stored |

Rules:
- One source of truth per value. If two places hold it, one will go stale.
- Derive instead of syncing. Do not copy props or server data into local state unless the user is editing a draft of it.
- Keep state as low as possible; lift it only to the nearest owner that all readers share.
- Reach for a global store last. Most apps need a server cache plus the URL plus local state.

## 2. Data fetching

- **Use a server-state layer** (query/SWR-style library or the framework's route loaders). It gives caching, dedup, retries, revalidation and cancellation. Hand-rolled fetch-in-effect code gets these wrong.
- **Key the cache by every input** (resource, id, filters, page, locale, user or tenant).
- **Fetch at the route or page level, in parallel.** Avoid parent-fetches-then-child-fetches waterfalls. Start requests as early as the inputs are known.
- **Cancel stale requests** when inputs change or the view unmounts (abort signal). Ignore responses that no longer match the current inputs, or a slow old response will overwrite a fast new one.
- **Mutations invalidate or update** the affected cache entries. For optimistic updates, keep the previous value and roll back on failure.
- **Prefetch on intent** (hover, focus, visible link) for likely next views.
- **Debounce input-driven requests** (search-as-you-type) and send the latest value only.
- **Validate response shapes** at the API client boundary; components receive typed, trusted data.
- Real-time data: server-sent events or WebSockets feeding the same cache, with reconnect and backoff.

## 3. Async UI states

Every async view designs four states: **loading, error, empty, success**.

- Loading: skeletons or placeholders that reserve the final size (no layout shift). Avoid spinners that flash for fast responses; delay them a few hundred ms.
- Error: a human message, a retry action, and the rest of the page still working. Isolate failures per region (error boundary or equivalent).
- Empty: explain why it is empty and what to do next.
- Stale data while refetching is usually better than blanking the view.
- Disable or mark controls that are pending; prevent double submits.

## 4. Forms

- Use real `<form>` semantics: submit on Enter, a `type="submit"` button, `name` on every field.
- **Every input has a visible label.** Placeholders are not labels.
- Validate on the client for fast feedback; **validate again on the server**, which is the source of truth. Share one schema between both when the stack allows.
- Validate on blur or submit, not on every keystroke for fields the user has not finished. Re-validate live once a field has shown an error.
- Show errors next to the field, link them with `aria-describedby`, move focus to the first invalid field on submit, and keep the user's input on failure.
- Map server field errors back onto the fields. Show non-field errors in a summary near the submit button.
- Disable submit while pending; make the server operation idempotent for retries (see `api-design`).
- Uncontrolled fields read on submit suit simple forms. Use a form library for multi-step forms, dynamic field arrays or cross-field rules.
- Warn before navigation away from unsaved changes when the form is long.

## 5. Routing and URL state

- **The URL is state.** Anything a user would share, bookmark or expect the back button to restore (filters, sort, page, tab, open item) goes in the URL.
- Replace history for keystroke-level changes (search text); push history for deliberate navigation.
- Split code by route; each route loads its own data, ideally in parallel with its code.
- Client-side route guards are for UX only. **Authorization is enforced on the server** for every request.
- Provide not-found and error routes. Handle deep links into every view.
- After navigation: move focus to the main heading or announce the new page, and restore or reset scroll deliberately.

## 6. Styling

- Pick **one** primary styling approach per project (utility classes, CSS modules, or a zero-runtime CSS-in-JS) and follow it. Mixed approaches drift.
- Put design decisions in **tokens** (CSS custom properties for color, spacing, radius, type scale, motion). Theme and dark mode switch tokens, not components.
- Prefer zero-runtime styling for server-rendered or performance-sensitive apps; runtime CSS-in-JS adds JS cost and complicates streaming.
- Build mobile-first with fluid layouts (flex, grid, `clamp()`), container queries where components need them.
- Animate `transform` and `opacity` only. Respect `prefers-reduced-motion`.
- Keep component styles colocated with the component; keep global CSS to resets, tokens and typography.
- Visual design direction and polish live in `web-design-guidelines`, not here.

## 7. Performance basics

- Code-split by route and by heavy, rarely used widgets (editors, charts, maps).
- Virtualize lists with hundreds of rich rows, or use `content-visibility` for long static content.
- Images: explicit dimensions, responsive `srcset`, modern formats, lazy loading below the fold, high priority for the main above-the-fold image.
- Defer third-party scripts until after the page is interactive.
- Measure with the browser's performance tools and field Web Vitals before optimizing.

## 8. Accessibility basics

Semantic elements first (`button`, `a`, `nav`, `main`, headings in order). Everything works by keyboard with a visible focus indicator. Dialogs trap focus, close on Escape and return focus to the trigger. Use ARIA only when no native element fits, and follow the ARIA pattern for the widget. Details and audits: `accessibility` skill.

## 9. Client-side security

- Treat everything from the server, URL and storage as untrusted for rendering. Never insert untrusted HTML; if rich text is required, sanitize it with a vetted sanitizer.
- No secrets in the client bundle: anything shipped to the browser is public.
- Prefer `HttpOnly`, `Secure`, `SameSite` cookies for session tokens over `localStorage`.
- Validate redirect targets (`?next=`) against an allowlist.

## Red flags in review

- Server data copied into a global store and updated by hand.
- Filters or pagination that reset on reload or break the back button.
- Fetches that can resolve out of order; no cancellation on input change.
- A view with no error or empty state; spinners that shift layout.
- Client-only validation; inputs without labels; errors that clear the user's input.
- Route guards as the only access control.
- Several styling systems in one project; hard-coded colors instead of tokens.

## Done when

- Each piece of state has one documented home matching the table above.
- Every async view handles loading, error, empty and success.
- Shareable view state survives reload and back/forward navigation.
- Forms validate on both client and server and are fully usable by keyboard.
