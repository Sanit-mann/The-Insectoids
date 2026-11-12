---
name: typescript-review
description: 'TypeScript and JavaScript review checks on top of code-review: type safety, async correctness, error handling, Node.js pitfalls, injection sinks, plus a React section for hooks, rendering, server/client boundaries, accessibility and React-specific security. Use when a diff touches .ts, .tsx, .js, .jsx, .mjs or .cjs files.'
metadata:
  kind: skill
  castes: [reviewer, inspector]
  tags: [review, typescript, javascript, react, quality]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: agents/typescript-reviewer.md
      license: MIT
    - repo: affaan-m/ecc
      path: agents/react-reviewer.md
      license: MIT
---

# TypeScript / JavaScript Review

Language-specific checks for a code review. Follow code-review for the process, the confidence gate, the output format (`path:line: severity: problem. fix.`) and verdicts. This skill only adds what to look for in TS/JS and React code. Report findings; do not rewrite the code.

## Before reviewing

1. **Scope.** Use the card's range. For a branch, diff against its real base (upstream or merge base), never an assumed `main`. Shallow history: inspect the last commit's patch for TS/JS files.
2. **Run the project's checks**, using its own scripts first:
   - typecheck: the project's `typecheck` script, else `tsc --noEmit -p <tsconfig that owns the changed files>` (in project-reference setups, the repo's non-emitting check). Skip for JS-only projects.
   - lint: the project's `lint` script, else ESLint on the changed files.
   - tests: the project's test command.
3. **Typecheck or lint failing:** report that as the first finding and stop; review resumes on green code.
4. **No TS/JS changes in scope:** say so and stop.
5. Read changed files in full plus their callers before commenting.

## Critical: security

- `eval`, `new Function`, `vm` or dynamic `import()` fed by user input.
- XSS: user input into `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`.
- SQL / NoSQL injection: query strings built with template literals or `+`; NoSQL operator objects (`$where`, `$ne`) accepted from request bodies.
- Path traversal: user input in `fs` calls or `path.join` without `path.resolve` plus a prefix check against the allowed root.
- `child_process.exec` / shell strings with user input: use `execFile`/`spawn` with an argument array and allowlisted values.
- Prototype pollution: deep-merging untrusted objects without schema validation or null-prototype targets; keys like `__proto__`, `constructor`.
- Hardcoded secrets; private secrets in client-exposed env vars.

## High: type safety

- `any` without a written reason: use `unknown` and narrow, or a precise type. A single `any` in a test fixture is not high.
- Non-null assertions (`value!`) with no guard that proves non-null.
- `as` casts that silence a real mismatch (casting to an unrelated type, `as unknown as T`) instead of fixing the type.
- `tsconfig` changes that weaken strictness (`strict`, `noImplicitAny`, `strictNullChecks` turned off, `skipLibCheck` added to hide errors): always call out.
- `@ts-ignore` / `@ts-expect-error` without a reason comment.
- External data (request bodies, `JSON.parse` results, env, third-party responses) typed by assertion instead of validated with a schema.

## High: async correctness

- Promises neither awaited nor given `.catch()`: unhandled rejections.
- Floating promises in event handlers or constructors with no error path. Intentional fire-and-forget should be marked (`void promise`) and handle its own errors.
- `array.forEach(async ...)`: does not wait. Use `for...of` or `Promise.all`.
- Sequential `await` in a loop over independent work where `Promise.all` is safe (and bounded).
- `Promise.all` over unbounded user-controlled input: needs a concurrency limit.
- Missing `AbortController` / timeout on `fetch` to external services.

## High: error handling

- Empty `catch {}` or catch blocks that log and continue as if nothing failed.
- `JSON.parse` on external input without try/catch or schema validation.
- `throw "message"` or throwing plain objects: throw `Error` (or a subclass) so stacks survive.
- Errors re-thrown without the original as `cause`.
- Internal error messages or stacks returned to clients.

## High: Node.js

- Synchronous fs or crypto (`readFileSync`, `pbkdf2Sync`) inside request handlers: blocks the event loop.
- Missing schema validation (zod, valibot, joi or the project's choice) at HTTP, queue and webhook boundaries.
- `process.env` read deep in code without startup validation or a safe default.
- Mixing `require` and ESM imports without clear intent; ESM-only packages required from CommonJS.
- Unbounded in-memory caches or listeners that grow per request (memory leak).

## Medium

- Module-level mutable state shared across requests.
- `==` / `!=` where operand types can differ and coercion changes the result (`== null` used to match both null and undefined is fine).
- Exported functions without explicit return types where inference leaks `any` or an unstable shape.
- Deep optional chains (`a?.b?.c?.d`) whose `undefined` result flows into logic with no fallback.
- `console.log` left in production paths: use the project's logger.
- Whole-library imports where a named or tree-shakeable import exists (frontend bundles).
- N+1: database or API calls inside loops.

Low or skip: `var` in legacy files, naming case, quote style, formatting, import order. Linters own these.

## React (when the diff has .tsx / .jsx or React imports)

### Critical: React security

- `dangerouslySetInnerHTML` with user-controlled HTML and no allowlist sanitizer at the same call site.
- `href` / `src` from user data without scheme validation: `javascript:` and `data:` execute code.
- Server Actions or server functions (`"use server"`) that accept input without schema validation or skip the authorization check. Treat them as public endpoints.
- Private secrets in client-exposed env vars (`NEXT_PUBLIC_*`, `VITE_*`, `REACT_APP_*`).
- Session tokens in `localStorage` / `sessionStorage`: use httpOnly cookies.

### Critical: hook rules

- Hooks called conditionally, in loops, after an early return, or outside a component or custom hook.
- State mutated in place (`items.push(x); setItems(items)`): no re-render, breaks memoized children.
- `react-hooks` lint rules (`rules-of-hooks`, `exhaustive-deps`) missing or disabled in project config: report as high.

### High: hook correctness

- Reactive values used inside `useEffect` / `useMemo` / `useCallback` but missing from the dependency array. Every `exhaustive-deps` disable needs a justification comment.
- Effects that only compute derived state (`useEffect(() => setX(f(y)), [y])`): compute during render.
- Effects without cleanup for subscriptions, intervals, listeners or in-flight fetches.
- Stale closures in async handlers or intervals: use the functional updater or a ref.
- Custom hooks not named `use...` (lint cannot check them).

### High: server / client boundary (React Server Components, Next.js App Router)

- `"use client"` files importing server-only modules (database clients, secret-holding SDKs, `server-only` modules).
- `"use client"` placed high in the tree, turning large subtrees into client code unnecessarily.
- Server Components passing full records with sensitive fields (password hashes, tokens) as props to Client Components.

### High: rendering and state

- `key={index}` in lists that reorder, insert or delete: state attaches to the wrong row. Use stable ids.
- The same data held in two states, or state plus a computed copy.
- Effect chains: an effect sets state that triggers another effect.
- State initialized from a prop that never resets when the prop changes: give the component a `key`.
- Data fetching without loading and error states; async subtrees without an error boundary.

### High: accessibility

- Clickable `div`/`span` instead of `button` or `a`: not keyboard reachable.
- Inputs without a label (`<label htmlFor>`, `aria-label` or `aria-labelledby`).
- `img` without `alt` (`alt=""` for decorative images).
- `target="_blank"` without `rel="noopener noreferrer"`.
- ARIA misuse: roles overriding native semantics, missing `aria-expanded` / `aria-controls` on disclosures.
- Skipped heading levels; color as the only error indicator.

### Medium: React performance, forms, composition

- New inline objects or functions passed to memoized children (defeats `memo`); heavy work in render without `useMemo`.
- Over-memoization with no measured benefit.
- Long lists (50+ non-trivial rows) without virtualization; `useContext` carrying high-frequency values.
- Suspense only at the route root instead of near the data.
- Forms without a `<form>` element, missing `name` attributes, `onSubmit` without `preventDefault()` (unless using framework form actions).
- Props drilled through more than 3 levels; components over ~200 lines doing several jobs; new class components.

## Useful commands

```
<project typecheck script>  or  tsc --noEmit -p <tsconfig>
<project lint script>       or  eslint <changed files>
<project test script>
<package manager> audit     (dependency advisories)
```

## Done when

- [ ] Typecheck, lint and tests run (or marked unavailable) before findings.
- [ ] Changed TS/JS read in context; React section applied when JSX/TSX changed.
- [ ] Findings pass the code-review confidence gate; verdict recorded per code-review.
