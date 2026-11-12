---
name: typescript-patterns
description: Write and review strict, type-safe TypeScript - compiler strictness, unknown over any, discriminated unions, brands, generics, validation at I/O boundaries, Result types, async concurrency and cancellation, module boundaries and type tests. Use when writing, reviewing or refactoring .ts/.tsx/.js code, designing types or tsconfig, or untangling cascading type errors.
metadata:
  kind: skill
  castes: [coder, reviewer]
  tags: [typescript, javascript, types, quality]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: skills/typescript-patterns/SKILL.md
      license: MIT
---

# TypeScript Patterns

Make the compiler do real work: model the program's shapes so wrong code fails to compile, and validate untrusted data once at the edge. Code examples: [references/examples.md](references/examples.md).

## When to use

- Writing or reviewing any TypeScript or JavaScript change.
- Removing `any`, tightening types, or turning on stricter compiler flags.
- Designing types, generics or module boundaries for a feature.
- A type error keeps cascading: that is usually a design problem, not an annotation problem.

Not for: React component design (use `react-patterns`), server layering (use `backend-patterns`).

## Compiler baseline

- `strict: true` is mandatory. A codebase that cannot compile under strict has a migration task, not an excuse.
- Also turn on: `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`, `forceConsistentCasingInFileNames`, `verbatimModuleSyntax`. Consider `exactOptionalPropertyTypes` (strict but noisy).
- Leave unused-code detection to the linter or `noUnusedLocals`/`noUnusedParameters`, whichever the project already uses.
- `moduleResolution`: `bundler` for bundled apps, `nodenext` for code Node runs directly or for published libraries.
- If the code runs through a runtime's type stripping (Node's built-in TypeScript support, as of Node 22.6+/23.6+), enable `erasableSyntaxOnly` (TS 5.8+). It forbids `enum`, `namespace` and parameter properties.
- When `noUncheckedIndexedAccess` is noisy, lift the element into a local and check it. Do not remove the flag.
- Large repos: `composite` + project references and `incremental`. Slow type-checking is a structure problem, not a reason to relax checks.

## Core rules

1. **`any` is a bug.** Use `unknown` and narrow. If a loosening is truly needed, make it explicit and comment why.
2. **Exports get explicit types, locals get inference.** Every exported function declares its parameter and return types.
3. **Casts (`as`) only after a real check**, and only inside the module that performed the check. A cast that skips a check is where shape bugs come from. Never use `as unknown as T` to silence an error.
4. **Non-null `!` only where an invariant is proven on the line above.** Otherwise narrow.
5. **Validate at the boundary, trust inside.** HTTP bodies, query strings, env vars, files, queue messages, `JSON.parse` and third-party responses are all `unknown` until a schema or type guard says otherwise.

## Type design

- `interface` for object shapes that may be extended; `type` for unions, intersections, tuples, mapped and conditional types.
- **String-literal unions over `enum`.** Same safety, no runtime artifact, no reverse-mapping surprises. Use `as const` objects if you need runtime values.
- **Discriminated unions for anything with several states.** Give each member a literal `kind`/`type` field, `switch` on it, and end with `assertNever(x)` so a new member fails to compile.
- **Brands for values that must not be mixed up** (`CustomerId` vs `OrderId`, cents vs dollars). Create branded values only in the validating function next to the check.
- **Generics when the type depends on the caller.** Constrain them (`T extends Shape`) when a shape is assumed. Do not return `unknown` and make callers cast.
- **Options object** once a function has more than two or three knobs. Make the fields the function truly depends on required. All-optional option types hide typos.
- **`readonly` / `ReadonlyArray` on parameters** the function does not mutate.
- **`satisfies`** to check a value against a type without widening it (keeps literal types).
- **No god types.** One interface that models several unrelated shapes should become a union or several interfaces.
- Keep heavy type machinery (deep conditional or template-literal types) inside boundary modules. Public APIs stay plain.

## Narrowing and null discipline

- Prefer type predicates (`value is T`) and assertion functions (`asserts value is T`) over casts.
- Use a schema library (any one, used consistently) at I/O edges so the schema is both the runtime check and the static type. Pick schema-first or type-first and stick to it across the codebase.
- Use `T | undefined` for legitimately absent values and compare explicitly (`=== undefined`).
- Avoid truthiness checks on values that can be `0`, `''` or `false`.
- Avoid long `?.` chains ending in a silent default: they hide bugs. Fail or branch explicitly.

## Errors

- Throw where the problem is detected; catch only where the caller can act (retry, translate, report). Do not wrap every call in try/catch.
- **Expected business outcomes** (validation failure, not found, conflict) go in the return type as a `Result` union. Exceptions are for the unexpected.
- Catch variables are `unknown` (strict sets `useUnknownInCatchVariables`). Narrow with `instanceof Error` before reading `.message`.
- Rewrap with `new Error(msg, { cause })` so the chain survives. Never stringify an error and drop the cause.
- **No silent catch.** `catch {}` hides failures callers assume were handled.
- Make promise-returning functions `async`, so every failure is a rejection. A non-async function that returns a promise can also throw synchronously, giving callers two error paths.

## Async

- `Promise.all` for all-or-nothing work (fail fast). `Promise.allSettled` when one failure must not drop the others.
- Start independent work together; do not `await` sequentially by habit.
- **Bound concurrency** when fanning out over large lists (a small worker pool). Hundreds of simultaneous requests exhaust sockets and rate limits.
- Pass an `AbortSignal` through long-running or outbound work. Use `AbortSignal.timeout(ms)` for timeouts; use a race-with-timer only when the operation cannot be aborted, and clear the timer.
- No floating promises: every promise is awaited, returned, or explicitly handled. Enforce with the `no-floating-promises` lint rule.

## Modules and dependencies

- Named exports over default exports. Each module exposes a deliberate public surface, typically an `index.ts` at the package or feature edge. Consumers do not import internals.
- Avoid catch-all barrels inside application code: they defeat tree-shaking and slow startup. Import concrete paths.
- Circular imports mean a shared type belongs in a module neither side imports.
- Dependencies point inward: domain (pure types and rules) <- application (use cases) <- infrastructure (adapters). Contracts never import implementations.
- Prefer built-ins (`Array`, `Map`, `Set`, `Intl`, `structuredClone`, `Object.groupBy`) over small utility packages.

## Performance

- Types cost nothing at runtime; structures do. Do not re-copy large unchanged objects in hot paths.
- Cache pure, expensive, repeated computations in a `Map` with a clear lifetime, not an ever-growing global.

## Type tests and tooling

- Lock public types with type-level tests (`expectTypeOf` in Vitest, or `tsd`). A type that silently loosens is a regression.
- Type-check: `tsc --noEmit` (watch mode for feedback). Lint with `typescript-eslint` type-aware configs (`recommended-type-checked` or `strict-type-checked`). They turn `no-unsafe-*` and `no-floating-promises` into near-compiler guarantees.
- Format with the project's formatter. Do not hand-format.

## Red flags in review

- `any`, `as` without a preceding check, `as unknown as`, `@ts-ignore` (prefer `@ts-expect-error` with a reason).
- `enum` in new code; boolean flags that should be a union.
- Exported functions without explicit types.
- `JSON.parse` or `await res.json()` result used without validation.
- Empty `catch`, errors rethrown without `cause`.
- `await` inside a loop over independent items; unbounded `Promise.all` over user-sized input.
- Promises neither awaited nor returned.

## Done when

- `tsc --noEmit` and the type-aware linter pass with no new suppressions.
- Every boundary input is validated before use; no unchecked casts remain.
- Public types are explicit and, for libraries, covered by type tests.
