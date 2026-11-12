---
name: lean-build
description: Build new behaviour as one complete, narrow, end-to-end slice that fits the existing system, with explicit non-goals and a clear stop condition. Use for new features, product slices or integrations where overbuilding is a risk. Not for bug fixes (surgical-patch) or restructuring (safe-refactor).
metadata:
  kind: skill
  castes: [coder]
  tags: [features, scope, simplicity, yagni]
  version: 1
  status: vetted
  sources:
    - repo: juliusbrussee/caveman
      path: skills/lean-build/SKILL.md
      license: Apache-2.0
---

# Lean Build

Deliver the feature as the smallest complete outcome that works end to end and fits the system. Not a stub, not a framework.

The rules of `coding-discipline` (simplicity first, surgical changes, goal-driven) apply throughout.

## When to use

- New behaviour: a feature, a product slice, an integration with another system.
- Any task where it would be easy to build more than was asked.

## Steps

1. **Derive acceptance and non-goals.** From the task card and the repository, write:
   - observable acceptance: what a user or caller can do when this is done, and how you will check it;
   - explicit non-goals: things you will deliberately not build (extra modes, settings, providers, polish).
2. **Look for what already exists.** Search the codebase for a similar feature, helper, pattern or extension point (a "seam") you can reuse before writing anything new.
3. **Trace the path.** Follow the entry point (route, command, UI action, event) through each layer that owns a rule or invariant (validation, business logic, storage, output).
4. **Build one coherent end-to-end path** across those responsible layers. Put each piece where its layer owns it. Never cram the whole feature into one file, one function or a local patch just to keep the diff small.
5. **Reuse the fitting seam.** Extend the existing pattern instead of creating a parallel one. Refactor first (see `safe-refactor`) only when patching would duplicate behaviour, weaken ownership or hide a root cause.
6. **Keep it runnable.** Each step should leave the system building and its tests passing.
7. **Exercise the path.** Run it for real (a test through the entry point, or a manual run) and run the focused tests.
8. **Stop** when acceptance passes.

## What to leave out

Omit unless acceptance needs it:
- modes, variants, feature switches;
- alternative providers or back ends;
- configuration and extension points;
- generalization for imagined future callers;
- polish beyond what acceptance describes.

Add new surface area (public endpoints, dependencies, services, configuration, schema migrations) only when the feature's lifecycle or acceptance requires it. When you do, state the trade-off in one line. A **new dependency needs approval** in the hive: request it through the Queen with the reason, rather than installing it on your own. Schema or data changes follow `reversible-migration`.

## Rules

- Complete beats clever: a narrow feature that works end to end beats a broad one that half works.
- Never sacrifice existing safety (validation, auth checks, error handling) to keep the change small.
- Match the conventions of the layers you touch.
- If acceptance can't be met without a design decision you weren't given, stop and ask through the task card.

## Red flags

- You are writing an interface with one implementation "for later".
- You added a setting nobody asked for.
- The feature only works when called from your test, not from the real entry point.
- You built a new helper that duplicates one already in the codebase.
- The diff keeps growing after acceptance already passes.

## Output

In the task card result:
- Acceptance criteria and the evidence that each passes.
- Non-goals you deliberately left out, but only those that matter, each with what would trigger building it.
- Any new surface area added and its trade-off.
