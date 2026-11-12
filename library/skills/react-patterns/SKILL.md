---
name: react-patterns
description: Idiomatic React 18/19 component design - pure render and derived state, hooks discipline, where state should live, composition instead of boolean props (compound components, explicit variants, provider-injected state), server/client component boundaries, Suspense and error boundaries, forms and actions. Use when writing, reviewing or refactoring React components, hooks or component APIs.
metadata:
  kind: skill
  castes: [coder, reviewer]
  tags: [react, frontend, components, composition]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: skills/react-patterns/SKILL.md
      license: MIT
    - repo: vercel-labs/agent-skills
      path: skills/composition-patterns/ (SKILL.md, rules/*.md)
      license: MIT
---

# React Patterns

Build React components whose render is predictable, whose state lives in the right place, and whose APIs grow by composition instead of by flags. Composition code: [references/composition.md](references/composition.md). Hooks, forms and React 19 examples: [references/examples.md](references/examples.md).

## When to use

- Writing or changing function components, custom hooks or component trees.
- Designing a reusable component API, or a component has started growing boolean props.
- Choosing where state lives (local, lifted, context, store, server cache).
- Working across Server and Client Components, Suspense, error boundaries or forms.

Not here: speed work (`react-performance`), tests (`react-testing`), framework-neutral UI architecture (`frontend-patterns`), WCAG detail (`accessibility`).

## Core rules

1. **Render is a pure function of props and state.** No side effects, network calls, subscriptions or mutations in the render body.
2. **Derive, don't sync.** Anything computable from props or state is computed during render. Storing it in state and syncing with `useEffect` adds a render, can desync and hides data flow.
3. **Effects only synchronize with external systems** (DOM APIs, subscriptions, timers, non-React widgets). Logic caused by a user action goes in the event handler.
4. **Compose, never inherit.** Use `children`, slots (element props) and compound components.
5. **Stable keys.** Use a data id, never the array index for lists that reorder, insert or delete.
6. **Never define a component inside another component.** Each render creates a new type and remounts the subtree.

## Hooks discipline

- Call hooks at the top level only; never in conditions or loops. (React 19's `use()` is the one exception and may be called conditionally.)
- Clean up every subscription, interval, listener and pending request in the effect's cleanup.
- Use the functional updater (`setX(prev => ...)`) when the next state depends on the previous one.
- Keep effect dependencies honest and primitive where possible. Do not silence the exhaustive-deps lint rule; restructure instead. For "latest value without re-subscribing", use `useEffectEvent` (React 19.2+) or a ref updated in an effect.
- Do not memoize by default. Add `useMemo`/`useCallback`/`memo` when a profiler or a memoized child's dependency proves it matters. If the project uses React Compiler, skip manual memoization.
- Extract a custom hook when the same hook sequence appears in two or more components, or to give a complex effect a name.

## Where state lives

```
Used by one component?                          -> useState / useReducer in it
Shared by a parent and a few children?          -> lift to the nearest common ancestor
Shared by siblings of a composed widget?        -> a provider component (see Composition)
Read across distant branches, changes rarely?   -> Context (theme, auth, locale)
Shared and updated often across the tree?       -> external store with selectors
Comes from the server?                          -> server-state cache or Server Component fetch
Should survive reload or be shareable?          -> the URL (search params)
```

Most screens need neither global context nor a store. Split contexts by concern so a fast-changing value does not re-render consumers of a slow one.

## Composition (component API design)

Ordered by impact.

1. **Avoid boolean-prop proliferation (critical).** Props like `isThread`, `isEditing`, `showFooter`, `isCompact` double the possible states each time and fill the component with nested conditionals. When you are about to add a mode flag, compose instead.
2. **Compound components.** Split a complex component into parts (`Composer.Frame`, `Composer.Input`, `Composer.Submit`) that share state through context. Consumers render only the parts they need, in the order they need.
3. **Lift state into a provider.** Put state in a provider component, not inside the visual frame. Any component inside the provider can read or act on it, even outside the frame (a preview pane, a dialog's footer button). Do not sync child state upward with effects, and do not read child state through refs.
4. **Decouple the state implementation.** Define a context interface of `{ state, actions, meta }`. UI parts depend only on that interface. Each provider decides whether state comes from `useState`, a store or server sync. Swap the provider, keep the UI.
5. **Explicit variants.** Instead of `<Composer isThread isEditing={false} />`, ship `ThreadComposer`, `EditMessageComposer`, and so on. Each composes the shared parts it needs and is self-documenting.
6. **`children` over `renderX` props** for static structure. Use a render prop only when the parent must pass data back (for example `renderItem` in a list).
7. Prefer a custom hook over a render-prop component that only shares logic.
8. Throw a clear error when a compound part is used outside its provider.

## React 19 notes

- `ref` is a regular prop for function components; new code does not need `forwardRef`.
- `use(Context)` reads context and, unlike `useContext`, may be called conditionally. `useContext` still works.
- `<Context value={...}>` can be rendered directly as the provider.
- Actions: `useActionState`, `useFormStatus`, `useOptimistic`, and `<form action={fn}>`.
- Skip these on React 18 and follow the project's installed version.

## Server and Client Components

Applies when the framework supports React Server Components.

- Server Components are the default. They can be `async`, read data directly and ship no JS for themselves.
- Add `"use client"` only at the leaves that need state, effects, browser APIs or event handlers. Keep the boundary low in the tree.
- Server to client: pass serializable props only (no functions, class instances or secrets). Pass only the fields the client uses.
- A Client Component cannot import a Server Component. Pass the server-rendered tree in as `children` or a slot prop.
- Server Actions (`"use server"`) are public HTTP endpoints. Validate input and authenticate and authorize inside every action. They must be defined in a server file or a Server Component, not inline in a client file.

## Suspense and error boundaries

- Place `<Suspense>` close to the data that suspends, so the rest of the page renders and slower parts stream in. Give fallbacks the same size as the content to avoid layout shift.
- Wrap independent regions in their own error boundary with a retry action. Boundaries catch errors during render and lifecycle, not in event handlers or async callbacks: handle those with try/catch and state.
- Error boundaries are still class components; a small wrapper library is fine.

## Forms

- React 19 with actions: `<form action>` plus `useActionState` for pending state and returned errors. Validate on the server too.
- Uncontrolled inputs (read `FormData` on submit) suit simple forms. Use controlled inputs when the value drives other UI, formats while typing or validates live.
- Multi-step, dynamic field arrays or cross-field rules: use a form library rather than hand-rolled state.
- Every input has a label. Show errors next to the field and announce them (`role="alert"` or `aria-describedby`).

## Data fetching

| Need | Use |
|---|---|
| Data for a server-rendered route | Fetch in a Server Component or the router's loader |
| Client cache, mutations, invalidation | A server-state library (query/SWR style) |
| Real-time updates | SSE, WebSockets, or the library's subscription API |
| One-off request from a user action | `fetch` in the event handler |

Do not use `useEffect` + `fetch` for application data: it races, has no cache, no dedup, no retry and no Suspense support.

## Accessibility basics

Use semantic elements (`button`, `a`, `nav`, `main`, `label`) before ARIA roles. Everything interactive works by keyboard. Manage focus when dialogs open and close and after route changes. Never put `onClick` on a `div` that should be a button. Details: `accessibility` skill.

## Red flags in review

- `useEffect` that sets state derived from props or other state.
- `useEffect` + `fetch` for app data; missing effect cleanup.
- A component with three or more boolean mode props, or `renderHeader`/`renderFooter` style props for static structure.
- State synced upward with effects or read from a child through a ref.
- Components defined inside components; array index keys on dynamic lists.
- Hooks called conditionally; exhaustive-deps warnings suppressed.
- `"use client"` at the top of a whole page tree; non-serializable or oversized props crossing to the client.
- Server Actions without auth and validation inside them.

## Done when

- Render paths are pure; no derived state in effects.
- State sits at the lowest level that serves all its readers.
- Component APIs vary by composition or explicit variants, not mode flags.
- Lint (rules of hooks, exhaustive deps) passes without suppressions.
