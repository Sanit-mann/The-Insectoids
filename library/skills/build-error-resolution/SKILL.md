---
name: build-error-resolution
description: Get a failing build, type check, compile, dependency install or framework startup back to green with the smallest possible changes - no refactoring, no redesign, no silencing checks. Use when a build, type check or startup fails. Language specifics for TypeScript/React and Python/Django are in references.
metadata:
  kind: skill
  castes: [coder]
  tags: [build, type-errors, compile, dependencies, minimal-diff]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: agents/build-error-resolver.md
      license: MIT
    - repo: affaan-m/ecc
      path: agents/react-build-resolver.md
      license: MIT
    - repo: affaan-m/ecc
      path: agents/django-build-resolver.md
      license: MIT
---

# Build Error Resolution

Fix the error, verify the build, stop. The goal is a green build with a minimal diff, not better code.

## When to use

- Build, compile or bundling fails.
- Type checker reports errors.
- Dependency install or resolution fails.
- The app or framework fails to start (configuration, imports, migrations state).

## When not to use

- Tests fail but the build is green: that is a behaviour problem (use `systematic-debugging`, then `surgical-patch`).
- The code needs restructuring (`safe-refactor`) or new features (`lean-build`).
- The error points to a real design problem (for example server-only code bundled into the client). Fix nothing; report it.

Stack specifics:
- TypeScript, JavaScript, React and bundlers: [references/typescript-react.md](references/typescript-react.md)
- Python and Django: [references/python-django.md](references/python-django.md)

## Steps

1. **Reproduce with the project's own command.** Run the configured build or check script first (from the package manifest, makefile or task runner), so you see what CI sees. Capture the full output.
2. **Collect all errors, not just the first.** Run the full type check or build in a mode that reports everything (non-incremental, no fail-fast where available).
3. **Categorize and prioritize.** Group errors: configuration, dependency, import/module resolution, type, syntax, environment (missing variable, service not running). Fix build-blocking errors first, then type errors, then warnings only if the task asks. Often one root cause (a bad config, a missing package, one wrong type) explains many errors: fix that first.
4. **For each error:**
   1. Read the message carefully: expected versus actual, file and line.
   2. Read the surrounding code to understand intent.
   3. Find the root cause, not just the line that reports it.
   4. Apply the smallest fix that addresses it.
   5. Re-run the build or check.
5. **Don't stack fixes.** Re-run after each fix. If a fix reveals a new error, treat it as a fresh diagnosis. Don't bundle unrelated fixes into one step.
6. **Run the tests** once the build is green, to make sure the fixes didn't change behaviour.
7. **Stop** when the build and type check pass with no new errors and tests still pass.

## Allowed fixes

- Add or correct a type annotation, a null/undefined check, a missing `async`/`await`.
- Fix an import path, a missing export, a named-versus-default import mismatch.
- Add a missing type package or a dependency that the code already uses but the manifest lacks.
- Correct a configuration value (compiler options, path aliases, bundler plugin, framework setting) so it matches what the code expects.
- Align versions of packages that must match each other.

## Not allowed

- Refactoring, renaming (unless the name itself causes the error), restyling or optimizing.
- Changing logic flow, unless the logic itself is the error.
- New features or architectural changes.
- Disabling the type checker, a lint rule or a compiler check to "make it green".
- Blanket suppressions (`any`, ignore-comments, broad casts, catch-all exception handlers). A single suppression is acceptable only with an inline comment saying why and what would remove it, and must be listed in your result.
- Deleting migration files, lockfiles or source files to make an error disappear.

## Hive approvals

- **Installing a new dependency** (one the project never used) needs approval through the Queen. Adding a type package or aligning an existing dependency's version is a normal fix; say so in the result.
- **Deleting files** needs approval. Clearing generated caches and build output inside your own workspace (for example the bundler's cache folder) is fine; deleting lockfiles, dependency manifests or source files is not.
- **Anything that touches shared databases or services** (resetting, faking or rolling back migrations against shared data) needs approval. Work against local or test databases only.

## Stop and report when

- The same error survives 3 fix attempts.
- A fix creates more errors than it removes.
- The real fix is architectural or crosses into other teams' code.
- The fix would risk data loss or need irreversible database operations.
- A required external service (database, cache, queue) is missing and needs setup.
- The toolchain version can't support the installed framework version.

## Output

One block per fix, then a summary:

```text
[FIXED] src/components/UserCard.tsx:14
Error: Object is possibly 'undefined'
Cause: user loaded async; type allows undefined
Fix: early return while user is undefined
Remaining errors: 2
```

```text
Build: SUCCESS | Errors fixed: 5 | Files changed: 3 (list) | Tests: passing
Build: FAILED  | Errors fixed: 3 | Blocked by: <reason> | Next: <what is needed>
```

Also list any suppressions added, dependencies added or aligned, and approvals requested.

## Red flags

- The diff is large compared with the number of errors.
- The type checker or a lint rule is now switched off.
- You changed code in files that had no errors and aren't the root cause.
- "Reinstall everything from scratch" as a first move instead of reading the error.
