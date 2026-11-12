---
name: dispatching-parallel-work
description: Decides which task cards are truly independent so they can be released to the taskboard at the same time, and which must wait, be merged or be serialized. Use when the Queen posts a wave of 2+ cards, or the Foreman balances the board, re-releases cards or decides how many insects to run at once.
metadata:
  kind: skill
  castes: [queen, foreman]
  tags: [parallelism, taskboard, scheduling, dependencies]
  version: 1
  status: vetted
  sources:
    - repo: obra/superpowers
      path: skills/dispatching-parallel-agents/SKILL.md
      license: MIT
    - repo: obra/superpowers
      path: skills/subagent-driven-development/SKILL.md
      license: MIT
    - repo: the-insectoids/functions
      path: 02-hive.md (taskboard, D2, D6, D7, Foreman)
      license: internal
---

# Dispatching Parallel Work

Independent cards run at the same time; dependent ones wait. In the hive nobody pushes work to an insect: a card is "dispatched" when it sits on the board with all its `depends_on` met, and an idle insect of the right caste pulls it (02-D2, D6). This skill is about getting that set right: wide enough to keep insects busy, never so wide that two insects collide.

## When to use

- **Queen:** after `writing-plans`, before posting a wave; when several unrelated problems show up at once (e.g. failures in different subsystems).
- **Foreman:** when releasing or re-releasing cards, after a lease expires, and when choosing how many insects to run.

## When not to parallelize

- **Related problems:** fixing one may fix the others. Post one investigation card first.
- **Exploratory work:** you don't yet know what is broken. Investigate, then split.
- **Needs the whole picture:** understanding requires seeing the entire system at once.
- **Shared state:** the cards would edit the same files or use the same resources.

## The independence test

Two cards can run at the same time only if **all** of these hold:

1. **No output dependency:** neither consumes an interface, file, result or decision the other produces.
2. **No shared write set:** they change different files, records and documents. Two edits to the same file conflict even when they touch different lines.
3. **No shared mutable resource:** not the same database, test fixture, port, branch, external account, or rate-limited service in a way that interferes.
4. **No ordering assumption:** each would be correct whichever finishes first.
5. **Self-contained:** each can be understood and checked without the other's context.
6. **Isolated failure:** if one fails, the other's result stays valid.

If any check fails, add a `depends_on` edge, merge the two cards, or split out the shared part into its own earlier card.

## Procedure

1. **List the candidate cards** with their write sets (files, records, resources) and interfaces (*Consumes* / *Produces*).
2. **Build a conflict map:** for each pair, run the independence test. Write down the overlaps you find.
3. **Group into independent domains** (one subsystem, one test file, one document each).
4. **Resolve conflicts:** serialize with `depends_on`, merge, or carve out the shared piece first.
5. **Order by priority and critical path:** critical and high cards on the critical path release first.
6. **Cap concurrency:** never above the user's maximum insect count, lowered automatically by the Treasurer near rate limits (02-D7). More cards than slots is fine; they wait on the board.
7. **Isolate workspaces:** parallel coding cards each get their own workspace (for example a separate branch or worktree) so they cannot overwrite each other. Add an integration card that depends on all of them.
8. **Post or release** the ready cards through the taskboard tool (atomic claim via the Brain's single writer means two insects never take the same card).

## Make each parallel card self-contained

A card that runs alongside others must be:
- **Focused:** one clear problem domain ("Fix `abort.test.ts`", not "fix the tests").
- **Self-contained:** paste the exact error messages, test names, file paths and values it needs.
- **Constrained:** say what not to touch ("do not change production code", "only files under `src/export/`").
- **Specific about output:** what the result must report (root cause and changes made).

| Mistake | Fix |
|---|---|
| Too broad: "Fix all the tests" | One file or subsystem per card |
| No context: "Fix the race condition" | Include errors, test names, file paths |
| No constraints: insect refactors everything | State allowed files and forbidden changes |
| Vague output: "Fix it" | "Report root cause and what you changed" |

## After the parallel cards finish

1. **Read each result:** understand what changed and any concerns or rulings.
2. **Check for collisions:** did two insects edit the same code or rely on conflicting assumptions?
3. **Run the integrated check:** the full test suite or whole-document review, as an integration or Inspector card, not per piece only.
4. **Spot check:** parallel insects can make the same systematic mistake. Look at one or two results in detail.
5. **Feed the next wave:** record outcomes in the Brain; plan the next wave from what you learned.

## Foreman notes

- Release a card only when every `depends_on` card is **done** (passed the Inspector), not merely in review.
- An expired lease returns the card to the board automatically; check its handoff before re-releasing so the next insect resumes rather than restarts.
- A card that keeps failing past its attempt limit is not a scheduling problem. Escalate it to the Queen.
- Many cards blocked on one card means that card is on the critical path: raise its priority.

## Example

Six test failures across three files after a refactor:
- `abort.test.ts` (3 failures, timing), `batch-completion.test.ts` (2, tools not running), `approval-race.test.ts` (1, count is 0).

The three files test separate subsystems, share no fixtures, and each fix stays inside its own module, so they pass the independence test. Post three coder cards, each with its own errors and "don't change code outside this module", plus one integration card (`depends_on` all three) that runs the full suite.

## Red flags

- Two ready cards list the same file in their write sets.
- A card "probably" doesn't need another's output: check the interfaces.
- Releasing a dependent card while its dependency is still in review.
- No integration check after parallel cards that touch one product.
- Running more insects than the user's cap because "the board is full".
