---
name: react-performance
description: Impact-ordered performance rules for React and Next.js-style apps - async waterfalls, bundle size, server caching and server/client serialization, client fetch dedup, re-renders, rendering and hydration, JS hot paths. Use when writing or reviewing React code for speed, or diagnosing slow loads, slow interactions, large bundles or Core Web Vitals regressions.
metadata:
  kind: skill
  castes: [coder, reviewer]
  tags: [react, nextjs, performance, web-vitals]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: skills/react-performance/SKILL.md
      license: MIT
    - repo: vercel-labs/agent-skills
      path: skills/react-best-practices/ (SKILL.md, rules/*.md)
      license: MIT
---

# React Performance

Fix the expensive things first: network waterfalls and shipped JavaScript cost far more than an extra render. Work down the priority list and stop when the measured problem is gone. Code for every rule: [references/rules.md](references/rules.md).

## When to use

- Slow page loads, slow interactions, high client CPU, large bundles.
- A Core Web Vitals regression (LCP, INP, CLS).
- Reviewing data loading in Server Components, API routes or Server Actions.
- Reviewing re-render-heavy UI (live filters, large lists, frequent store updates).

Not here: component API design (`react-patterns`), framework-neutral loading strategy (`frontend-patterns`).

## Method

1. **Measure first.** Use the browser performance panel, the React DevTools profiler, a bundle analyzer, server timing logs or field Web Vitals. Write down the baseline.
2. **Name the metric and the cause** (for example "LCP 4.1s: three sequential awaits in the page").
3. **Apply the highest-priority rule that fits.** Do not micro-optimize while a waterfall or a large bundle remains.
4. **Measure again** and keep only the changes that helped.

| Metric | Look first at |
|---|---|
| LCP (load) | Waterfalls, bundle size, server time, resource hints, image priority |
| INP (interaction) | Re-renders, long tasks, heavy JS, transitions |
| CLS (layout shift) | Suspense fallbacks and images without reserved size, late-injected content |
| TBT / long tasks | Bundle size, third-party scripts, hydration cost |

## 1. Eliminate waterfalls (critical)

Every sequential `await` adds a full round trip.

- Check cheap synchronous conditions (props, flags in memory) before awaiting anything remote.
- Move each `await` into the branch that actually needs the value.
- Run independent work with `Promise.all`.
- Partial dependencies: start every promise as early as possible, await each only where its result is needed. Chain dependent calls with `.then` so they do not wait for unrelated ones.
- In API routes and Server Actions, start auth, config and data loads together.
- In Server Components, split sibling data needs into separate async child components so they fetch in parallel.
- Stream with `<Suspense>` near slow data; give fallbacks the content's size.

## 2. Cut bundle size (critical)

- Avoid barrel imports of large libraries (icon sets, component kits, utility libraries). Import the direct path, or use the framework's package-import optimization (for example Next.js `optimizePackageImports`). Check that deep paths ship types before using them.
- Keep dynamic `import()` paths statically analyzable: one literal path per branch, not template strings.
- Lazy-load heavy, below-the-fold or interaction-only components (`React.lazy` or the framework's dynamic import).
- Load features only when activated (admin panels, editors, charts).
- Load analytics, chat widgets and logging after hydration or on idle.
- Preload on intent: start the `import()` or data fetch on hover or focus.
- Check the result with a bundle analyzer.

## 3. Server-side (high)

- **Authenticate and authorize inside every Server Action.** It is a public endpoint whatever UI calls it.
- Deduplicate per request with `React.cache()` (one DB call however many components ask).
- Cache across requests with an LRU (process-local) or a shared cache, or the framework's data cache. Process-local caches do not help across isolated serverless instances.
- Pass the client only the fields it renders. Every prop crossing to a Client Component is serialized into the page.
- Serialization dedupes by reference: do not send both `items` and `items.toSorted()`. Transform on the client unless the transform is expensive.
- Hoist static I/O (fonts, logos, config) to module scope so it runs once.
- **Never keep request data in mutable module state.** Concurrent renders share the process and can leak one user's data into another's response.
- Run nested per-item fetches inside `Promise.all`, not a sequential loop.
- Defer non-blocking work (logging, analytics, cache warming) until after the response, for example Next.js `after()`.

## 4. Client data fetching (medium-high)

- Shared data goes through a server-state library (query or SWR style) so components share one request and one cache entry. Never `useEffect` + `fetch` for shared data.
- Share one global listener across component instances instead of one per instance.
- Mark scroll and touch listeners `{ passive: true }` when they do not call `preventDefault()`.
- `localStorage`: version the schema, keep payloads small (it is synchronous), and wrap access in try/catch.

## 5. Re-renders (medium)

If React Compiler is enabled, manual `memo`/`useMemo`/`useCallback` is mostly unnecessary. Keep only the structural rules here (derive state, subscribe narrowly, no inline components).

- Derive values during render; never mirror them into state with an effect.
- Do not subscribe to state that is only read inside a callback; read it when the callback runs.
- Subscribe to derived values (`cart.length > 0`), not whole objects.
- Memoize an expensive subtree as its own component so early returns skip it.
- Hoist default non-primitive props (`items ?? EMPTY`) so `memo` children are not broken by new identities.
- Use primitive effect dependencies, not freshly built objects.
- Use the functional `setState` form so callbacks need no state dependency.
- Use a lazy initializer for expensive initial state: `useState(() => parse(x))`.
- Do not `useMemo` trivial expressions.
- Split a hook with unrelated inputs into separate hooks.
- Put interaction logic in event handlers, not effects.
- Mark non-urgent updates with `startTransition`; use `useDeferredValue` to keep input responsive while an expensive view catches up.
- Keep fast-changing values that do not affect output (timers, last key) in refs.
- Never define components inside components.

## 6. Rendering (medium)

- Virtualize long lists, or use `content-visibility: auto` with `contain-intrinsic-size` for long static content.
- Animate a wrapper element's `transform`/`opacity`, not SVG attributes or layout properties.
- Hoist static JSX out of components.
- Round SVG path precision in exported assets.
- Client-only values needed before paint (theme): set them with a tiny inline script before hydration to avoid flicker.
- Use `suppressHydrationWarning` only on a single leaf that legitimately differs (timestamps), never on a subtree.
- Use `<Activity mode="hidden">` (React 19.2+) to hide and keep state of expensive toggled views instead of unmounting.
- Render conditionals with a ternary or explicit boolean; `count && <X/>` renders `0`.
- Use `useTransition`'s `isPending` for loading state instead of extra flags.
- Use React DOM resource hints (`preload`, `preconnect`, `prefetchDNS`) for critical resources.
- Put `defer` or `async` on non-critical scripts.

## 7. JavaScript hot paths (low-medium)

Only in measured hot paths: batch DOM style changes via classes; build a `Map` or `Set` for repeated lookups; combine `filter().map()` into one pass (`flatMap` or a loop); hoist `RegExp` creation out of loops; use a single loop for min/max instead of sorting; check lengths before expensive comparisons; return early; cache repeated storage reads; use `toSorted()` instead of mutating props; defer non-critical work to `requestIdleCallback`.

## 8. Advanced (low)

- `useEffectEvent` (React 19.2+) gives a stable function that sees the latest props. Never put it in a dependency list.
- Older React: store the latest handler in a ref updated inside an effect. Do not write refs during render.
- App-wide one-time initialization belongs in the entry module or behind a module-level guard, not in a component's mount effect (effects re-run on remount and run twice in development Strict Mode).

## Red flags in review

- Sequential independent `await`s; `await` before a cheap early return.
- `import { X } from 'huge-lib'` in client code without import optimization; template-string `import()`.
- Whole DB rows passed to Client Components; mutable module-level request state.
- Server Action without auth inside it.
- `useEffect` + `fetch`, effects that set derived state, components defined inside components.
- `{count && ...}`, unvirtualized lists of hundreds of rich rows, layout-shifting fallbacks.

## Done when

- The target metric has a before and after number, and the after meets the goal.
- No remaining higher-priority issue (waterfall, oversized bundle) on the measured path.
- Changes that did not move the metric were reverted.
