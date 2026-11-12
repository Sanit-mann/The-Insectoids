---
name: surgical-patch
description: Fix a bug or make a small behaviour change at the narrowest layer that owns the wrong behaviour, with regression proof and nothing else touched. Use for bug fixes and small tweaks where preserving surrounding behaviour matters. Not for new features (use lean-build) or restructuring (use safe-refactor).
metadata:
  kind: skill
  castes: [coder]
  tags: [bugfix, minimal-diff, regression]
  version: 1
  status: vetted
  sources:
    - repo: juliusbrussee/caveman
      path: skills/surgical-patch/SKILL.md
      license: Apache-2.0
---

# Surgical Patch

Fix the fault where it lives, prove it is fixed, and leave everything else exactly as it was.

## When to use

- A bug fix, or a small change to existing behaviour.
- The surrounding code must keep working as before.

Not for: new features (`lean-build`), structural cleanup (`safe-refactor`), build or type errors (`build-error-resolution`), data or schema changes (`reversible-migration`).

## Steps

1. **Capture the failure.** Reproduce it first, ideally as a failing automated test. If a test is too costly, capture the strongest evidence you can: exact error, log line, input that triggers it, steps to reproduce.
2. **Trace the symptom to the mechanism.** Follow the failure from where it shows up back to the code that actually decides the wrong thing. The place where the error appears is often not the place that is wrong.
3. **Pick the narrowest responsible layer.** Change the layer that *owns* the incorrect behaviour, not a caller that hides it. Patching the symptom downstream (an extra null check, a special case in the UI) leaves the real fault for the next caller to hit.
4. **Make the smallest change that fixes it.** Match the existing style. Remove only what your change made unused.
5. **Add regression proof.** One test (or the reproduction from step 1) that fails without the fix and passes with it. Only proof relevant to this fault.
6. **Run the proof, then the nearest gate.** Run the focused test first, then the closest wider check that could be affected (the module's test suite, the type check, the build).
7. **Stop and report.** Stop as soon as the failure is fixed and the regression proof passes.

## Rules

- Preserve unrelated behaviour, including odd behaviour other code may depend on.
- Preserve user or teammate changes already in the working tree. Never overwrite or revert them.
- No cleanup, renaming, reformatting or new abstractions outside the fix. Note them in your result instead.
- If the true fix needs a wider change (interface change, several modules, data migration), stop and report back with your findings rather than widening scope on your own.
- If you cannot reproduce the failure, say so. Do not ship a speculative fix as if it were proven.

## Red flags

- The diff touches files that have nothing to do with the fault.
- You fixed it without ever seeing it fail.
- The fix is a broad try/catch, a default value or a suppressed warning that hides the error.
- "While I'm here…" changes.

## Output

In the task card result:
- Root cause in one or two sentences (file and line).
- What changed and why that layer.
- The regression proof and the checks run, with results.
- Anything noticed but deliberately left alone.
