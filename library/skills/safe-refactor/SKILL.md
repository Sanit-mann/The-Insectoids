---
name: safe-refactor
description: Restructure code without changing behaviour - extract, move, consolidate duplicates or remove dead code - with verification before and after every step. Use when a task asks for cleanup or restructuring. Not during active feature work in the same area, right before a release, or on code without tests you can trust.
metadata:
  kind: skill
  castes: [coder]
  tags: [refactoring, dead-code, cleanup, behaviour-preservation]
  version: 1
  status: vetted
  sources:
    - repo: juliusbrussee/caveman
      path: skills/safe-refactor/SKILL.md
      license: Apache-2.0
    - repo: affaan-m/ecc
      path: agents/refactor-cleaner.md
      license: MIT
---

# Safe Refactor

Change the structure, keep the behaviour. Verification brackets every structural edit: proof before, proof after, same proof both times.

## When to use

- Extracting functions or modules, moving code to its proper owner, consolidating duplicates.
- Removing dead code: unused exports, files, dependencies, duplicates.

## When not to use

- During active feature development in the same area. Finish or park the feature first.
- Right before a release or deploy.
- Without tests (or other checks) that would catch a behaviour change. Add characterization tests first, or don't refactor.
- On code you don't understand yet. Read and trace it first.
- When the task is really a bug fix (`surgical-patch`) or new behaviour (`lean-build`).

## Steps

1. **Define the preservation boundary.** Write down what must not change: public interfaces, return values, error behaviour, ordering, side effects, performance-sensitive paths, compatibility with callers and stored data.
2. **Establish verification first.** Run the tests, type check and build *before* any edit and record the result. If coverage of the area is thin, add characterization tests that pin current behaviour (including odd behaviour) and confirm they pass.
3. **Move one ownership boundary at a time.** One extraction, one move or one consolidation per step.
4. **Keep every intermediate state buildable and testable.** Never leave the code half-moved between steps.
5. **Re-run the same proof after each step.** Same tests, same checks. Any difference means you changed behaviour: undo the step and redo it smaller.
6. **Commit after each green step** with a `refactor:` message, so any step can be reverted alone.
7. **Stop** when behaviour matches and the requested structure is achieved.

## Rules

- No feature changes or bug fixes inside a refactor. If you find a bug, note it and keep it as-is (or stop and report if it blocks you).
- Preserve public interfaces, failure behaviour, ordering and compatibility unless the task explicitly scopes a change.
- Don't add dependencies or configuration unless correctness needs them.
- Don't rename or reformat beyond what the restructuring requires.

## Dead code removal

Removing unused code looks free and often isn't: dynamic references, reflection and external callers are invisible to a quick search.

**1. Detect.** Use the project's own tools: compiler and linter "unused" warnings, unused-export and unused-dependency analyzers for the language, coverage reports. Then confirm by searching.

**2. Classify each candidate by risk.**

| Risk | Examples | Treatment |
|---|---|---|
| Safe | Unused private function, unused import, unused internal dependency | Remove after verification |
| Careful | Anything that could be reached dynamically: string-built imports, reflection, plugin registries, routes, config-referenced names, templates | Remove only with positive proof it is unreachable |
| Risky | Public API, exported library surface, anything outside callers may use, feature-flagged code | Don't remove; list it in your result for a decision |

**3. Verify each item before removing.**
- Search for every reference, including string forms of the name (dynamic imports, config files, templates, serialized data, scripts, docs).
- Check whether it is part of a public or exported interface.
- Check version-control history for why it exists (recently added code may be about to be used).

**4. Remove in small batches, one category at a time:** dependencies, then exports, then files, then duplicates. After each batch: build, run tests, commit.

**5. Consolidate duplicates.** Pick the best implementation (most complete, best tested), point all callers at it, then remove the others. Verify after.

**Deleting whole files needs approval** in the hive. Removing code inside a file is a normal edit; deleting a file is not. List proposed file deletions with their evidence in your task result and request approval through the Queen before deleting. When in doubt, don't remove.

## Red flags

- A test changed its expected value during a refactor.
- A step touches many modules at once.
- You removed something because "nothing seems to use it" without searching string references.
- The diff mixes refactoring with new behaviour.

## Output

In the task card result:
- The preservation boundary and the proof run before and after (with results).
- The steps taken (one line each, matching commits).
- For dead code: what was removed, what was kept as Careful or Risky and why, and any files awaiting deletion approval.
