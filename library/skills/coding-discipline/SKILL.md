---
name: coding-discipline
description: Baseline rules for writing and changing any code - think before coding, keep it simple, change only what the task needs, and define how success will be verified. Includes language-neutral quality rules (naming, errors, nesting, constants, comments). Load for every coding task, review or refactor, in any language.
metadata:
  kind: skill
  castes: [coder, reviewer, tester]
  tags: [coding, quality, simplicity, scope]
  version: 1
  status: vetted
  sources:
    - repo: multica-ai/andrej-karpathy-skills
      path: skills/karpathy-guidelines/SKILL.md
      license: MIT
    - repo: affaan-m/ecc
      path: skills/coding-standards/SKILL.md
      license: MIT
---

# Coding Discipline

The floor every coder stands on. These rules prevent the most common agent coding mistakes: guessing silently, overbuilding, wandering outside the task, and calling work done without proof.

They favour care over speed. For a truly trivial change, use judgment, but never skip verification.

## When to use

- Always, whenever you write, change, review or refactor code.
- Language- and framework-specific skills add detail on top; they never replace this one.

## 1. Think before coding

Don't assume. Don't hide confusion. Surface trade-offs.

- Read the task card's brief and acceptance criteria before touching code.
- State your assumptions explicitly. If one is uncertain and matters, ask (through the task card) instead of guessing.
- If the request can be read more than one way, list the readings. Do not pick one silently.
- If a simpler approach exists than the one asked for, say so. Push back when warranted.
- If something is unclear, stop. Name exactly what is confusing and ask.
- Look at how the codebase already does similar things before inventing a new way.

## 2. Simplicity first

Write the minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked (YAGNI).
- No abstractions for code used once.
- No "flexibility", options or configuration nobody requested.
- No error handling for situations that cannot happen.
- Prefer clear and boring over clever. No premature optimization.
- If you wrote 200 lines and it could be 50, rewrite it.
- Test: would a senior engineer call this overcomplicated? If yes, simplify.

Duplication versus abstraction: copying two or three similar lines is fine. Extract shared logic when the same *behaviour* genuinely repeats and must change together, not because two pieces of code look alike.

## 3. Surgical changes

Touch only what you must. Clean up only your own mess.

When editing existing code:
- Don't "improve" nearby code, comments or formatting.
- Don't refactor things that aren't broken.
- Match the existing style, even if you would do it differently.
- If you notice unrelated dead code or bugs, mention them in your result. Don't fix or delete them.

When your change leaves orphans:
- Remove imports, variables and functions that *your* change made unused.
- Leave pre-existing dead code alone unless the task asks.

The test: every changed line traces directly to the task.

## 4. Goal-driven execution

Define success criteria. Loop until they are verified.

Turn each task into a checkable goal:
- "Add validation" becomes "write tests for invalid inputs, then make them pass".
- "Fix the bug" becomes "write a test that reproduces it, then make it pass".
- "Refactor X" becomes "tests pass before and after, behaviour unchanged".

For multi-step work, state a short plan with a check for each step:

```
1. [step] -> verify: [check]
2. [step] -> verify: [check]
3. [step] -> verify: [check]
```

Strong criteria let you work without asking. Weak criteria ("make it work") force constant clarification. Never report done on a check you did not run.

## 5. General quality rules

Language-neutral defaults. Where the project has its own convention, follow the project.

**Naming**
- Use descriptive names: `totalRevenue`, not `x`; `isUserAuthenticated`, not `flag`.
- Name functions verb-first: `fetchOrder`, `calculateTax`, `isValidEmail`.
- Booleans read as questions: `is…`, `has…`, `can…`, `should…`.

**Readability**
- Code is read far more than written. Optimize for the next reader.
- Keep functions small and single-purpose. Treat ~50 lines as a signal to split.
- Avoid deep nesting: use early returns and guard clauses instead of 4+ levels of `if`.
- Replace magic numbers and strings with named constants (`MAX_RETRIES = 3`).
- Follow the project's formatter and linter; don't hand-format against them.

**Data and state**
- Prefer creating new values over mutating shared ones. Mutate in place only when it is clearly local or needed for performance, and comment why.
- Use the type system: precise types over "any"/untyped values; model allowed states explicitly (enums, unions).
- Validate input at system boundaries (requests, files, user input, external APIs), then trust it inside.

**Errors**
- Handle errors explicitly. Never swallow an error silently.
- Error messages say what failed and with what (status, id, input), without leaking secrets.
- Keep the original cause when re-raising or wrapping.
- Don't add handling for impossible cases (see Simplicity).

**Concurrency**
- Run independent async operations in parallel rather than one after another, when order does not matter.

**Comments**
- Comment *why*, not *what*. The code says what.
- Document public interfaces (purpose, parameters, return, errors) in the project's doc style.
- Delete comments that only restate the code.

**Tests**
- Structure tests as arrange, act, assert.
- Name tests by behaviour: "returns empty list when no orders match", not "works".

## Red flags

- You are about to edit a file the task never mentioned.
- You added an option, parameter or layer "in case we need it later".
- You are reformatting or renaming code you were not asked to touch.
- You picked an interpretation of an ambiguous request without saying so.
- You are about to say "done" without having run the check that proves it.
- A diff that should be 10 lines is 200.

## Done when

- Every changed line traces to the task.
- The success checks you defined have been run and pass.
- Assumptions, open questions and noticed-but-untouched issues are listed in your task result.
