# TypeScript, JavaScript and React Build Errors

Detail for `build-error-resolution`. Always prefer the project's own scripts over the raw commands below.

## Diagnose

```bash
# Project scripts first (use the project's package manager)
npm run build --if-present
npm run typecheck --if-present

# Type check on its own, all errors, using the project's pinned compiler
npx --no-install tsc --noEmit --pretty --incremental false -p tsconfig.json

# Lint (only if the task covers lint errors)
npx --no-install eslint .
```

Use `--no-install` so you never run an unpinned compiler version the project didn't choose.

### Detect the build system (first match wins)

| File or marker | Build system |
|---|---|
| `next.config.*` | Next.js |
| `vite.config.*` | Vite |
| `rsbuild.config.*` | Rsbuild |
| `react-scripts` in package.json | Create React App |
| `webpack.config.*` | webpack |
| `.parcelrc` or `parcel` in package.json | Parcel |
| `bunfig.toml` plus bun scripts | Bun |

Identify which layer is failing: TypeScript, bundler configuration, runtime (server render), or hydration.

## Common TypeScript errors

| Error | Usual minimal fix |
|---|---|
| `implicitly has an 'any' type` | Add a type annotation |
| `Object is possibly 'undefined'` / `'null'` | Optional chaining, a null check, or an early return |
| `Property 'x' does not exist on type` | Add it to the interface (optional if it really can be missing), or fix the property name |
| `Cannot find module 'x'` | Fix the import path, sync `paths` aliases with the bundler, or add the missing package/type package |
| `Type 'X' is not assignable to type 'Y'` | Convert or parse the value, or correct the declared type to match reality |
| Generic constraint errors | Add `extends { ... }` to the type parameter |
| `'await' expressions are only allowed within async functions` | Mark the function `async` |
| `Module has no exported member 'X'` | Named vs default import mismatch, or types for the wrong library version |

## JSX / TSX compile errors

| Error | Cause | Fix |
|---|---|---|
| `'React' is not defined` | Old JSX transform expected `import React` | Set `"jsx": "react-jsx"` (React 17+) or add the import |
| `Cannot find module 'react' or its corresponding type declarations` | Missing types | Add `@types/react` and `@types/react-dom` matching the installed React major |
| `JSX element type 'X' does not have any construct or call signatures` | Importing something that isn't the component | Check default vs named export |
| `Unexpected token '<'` | No JSX transform in the bundler | Add the bundler's React plugin or loader |
| `JSX expressions must have one parent element` | Adjacent siblings | Wrap in a fragment `<>...</>` |

## tsconfig

| Symptom | Fix |
|---|---|
| `"jsx"` not set | `"react-jsx"` for React 17+, `"react"` for legacy |
| Default import of a CommonJS module fails | `"esModuleInterop": true` |
| Bundler-style imports not resolving | `"moduleResolution": "bundler"` for modern bundlers |
| Path aliases work in the editor but not the build | Keep `paths` in tsconfig and the bundler's alias config in sync |

## Bundler notes

- **Vite:** the React plugin must be in the `plugins` array; CommonJS-only dependencies may need `optimizeDeps.include`; libraries expecting `process.env.NODE_ENV` need a `define` entry.
- **webpack:** a loader rule for `.jsx`/`.tsx`; `resolve.extensions` must include them; an over-broad ignore pattern can drop needed modules.
- **Create React App:** unmaintained. Fix within it (version drift between `react-scripts` and React, missing `browserslist`, overrides shadowing defaults); migration to another bundler is a separate task, not a build fix.
- **Tailwind/PostCSS:** content globs must cover the source files; the CSS entry needs the Tailwind directives; `tailwindcss` runs before `autoprefixer`.

## Next.js App Router

| Error | Fix |
|---|---|
| `You're importing a component that needs useState` (or other hooks) | Add `"use client"` at the top of that file, or move the hook into a small client child component |
| `Module not found: Can't resolve 'fs'` in client code | Server-only code is being bundled for the browser. Move it to a server component or route handler. If that means redesigning the boundary, stop and report |
| `Functions cannot be passed directly to Client Components` | Pass a Server Action (`"use server"`) instead of a plain function |

## Hydration mismatches

Server HTML differs from the first client render. Usual causes and fixes:

1. Non-deterministic values during render (`Date.now()`, `Math.random()`, locale formatting): compute them in an effect, render a stable placeholder first.
2. Browser-only APIs during render (`window`, `document`, `localStorage`, `navigator`): move into an effect.
3. CSS-in-JS without server-side setup: configure the library's SSR integration.
4. Invalid HTML nesting (`<div>` inside `<p>`, `<a>` inside `<a>`): fix the markup.
5. User-agent-dependent output: render the client-only branch after mount.

## Runtime errors that surface at build or start

| Error | Fix |
|---|---|
| `Invalid hook call` | Usually two copies of React. Check `npm ls react` shows one; dedupe or align versions with package-manager overrides |
| `Element type is invalid ... got: undefined` | Default vs named import mismatch |
| `Functions are not valid as a React child` | Call the function or render it as a component |

## Dependencies

```bash
npm ls react              # duplicates?
npm ls @types/react       # aligned with react?
npm dedupe
```

Upgrade `react` and `react-dom` together, within the major already in use. Jumping a major version is a separate, deliberate task (see `reversible-migration`).

## Caches

Stale build caches cause phantom errors. Clearing the framework's own cache folder in your workspace (for example `.next/` or `node_modules/.cache/`) is fine. Deleting `node_modules` and the lockfile to reinstall from scratch changes resolved versions: don't do it as a fix without approval.
