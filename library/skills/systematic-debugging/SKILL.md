---
name: systematic-debugging
description: 'Find the root cause before changing anything: read the error, reproduce, gather evidence, rank hypotheses, test one at a time, then fix at the source with a failing test first. Use for any bug, test failure, build failure, flaky or intermittent behavior, performance regression or unexpected result, before proposing or editing a fix.'
metadata:
  kind: skill
  castes: [coder, tester]
  tags: [debugging, quality, root-cause]
  version: 1
  status: vetted
  sources:
    - repo: obra/superpowers
      path: skills/systematic-debugging/SKILL.md
      license: MIT
    - repo: obra/superpowers
      path: skills/systematic-debugging/root-cause-tracing.md
      license: MIT
    - repo: obra/superpowers
      path: skills/systematic-debugging/defense-in-depth.md
      license: MIT
    - repo: obra/superpowers
      path: skills/systematic-debugging/condition-based-waiting.md
      license: MIT
    - repo: juliusbrussee/caveman
      path: skills/investigate-first/SKILL.md
      license: Apache-2.0
---

# Systematic Debugging

Investigate before editing. A fix without a known root cause is a guess, and guesses create new bugs.

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

## When to use

Any technical problem: test failures, production bugs, build failures, integration issues, flaky tests, slow code, "it worked yesterday".

Use it **especially** when:
- A quick fix seems obvious (simple bugs have root causes too).
- You are under time pressure (systematic is faster than thrashing).
- A previous fix did not work, or you have tried several.
- You do not fully understand the problem.

## Phase 1: root cause investigation

Do not change product code in this phase. Diagnostic logging is allowed; remove it before submitting.

1. **Read the error completely.** Full message, full stack trace, file paths, line numbers, error codes, warnings above it. They often name the answer.
2. **Reproduce.** Find exact steps that trigger it. Does it happen every time? If you cannot reproduce it, gather more data; do not guess.
3. **Check recent changes.** Diff, recent commits, new or upgraded dependencies, config and environment differences. Check the Brain for earlier lessons on this area or error.
4. **Separate symptom from cause.** Write down what you *observed* and, separately, what you *infer*. Only observations are evidence.
5. **Instrument boundaries in multi-part systems.** When data passes through several components (CI -> build -> deploy, API -> service -> database), log what enters and leaves each boundary and check config and environment propagation at each layer. Run once to see *where* it breaks, then investigate only that component.
6. **Trace data flow backward.** When the error appears deep in a call chain, ask where the bad value came from, what called this with it, and keep going up until you reach the original trigger. Fix there, not where it surfaced. Technique: [references/root-cause-tracing.md](references/root-cause-tracing.md).

## Phase 2: pattern analysis

1. **Find a working example.** Similar code in the same codebase that works.
2. **Read the reference completely.** If you are following a pattern or library doc, read every line, not a skim.
3. **List every difference** between working and broken, however small. Do not assume any "can't matter".
4. **Map dependencies.** What other components, settings, environment and assumptions does the broken code need?

## Phase 3: hypotheses and testing

1. **List hypotheses and rank them** by how well they fit the evidence and how cheaply each can be disproved. Test cheap, likely ones first.
2. **State one clearly:** "I think X is the root cause because Y." Record it.
3. **Test minimally.** The smallest change or probe that confirms or kills it. One variable at a time.
4. **Read the result.** Confirmed: go to Phase 4. Disproved: form a new hypothesis. Do not stack another change on top.
5. **Stop exploring** as soon as one mechanism explains all the evidence, or you can name the exact blocker.
6. **When you do not know, say so.** "I don't understand X" is a valid finding. Research more or ask through the card; never pretend.

If the card is investigation-only, stop here: report cause and proof, make no fix.

## Phase 4: fix

1. **Write a failing test** that reproduces the bug (automated if any framework exists; a one-off script otherwise). Follow test-driven-development. Watch it fail.
2. **Make one fix** that addresses the root cause. No "while I'm here" changes, no bundled refactors.
3. **Verify.** The new test passes, the full suite passes, and the original symptom is gone when reproduced the original way. Then run verification-before-completion.
4. **Harden if the bug came from bad data.** Consider validation at each layer the data passes through so the bug becomes structurally impossible: [references/defense-in-depth.md](references/defense-in-depth.md).
5. **Record the lesson** in the Brain: symptom, root cause, fix, how it was found.

### If the fix does not work

- Stop. Count your attempts.
- Fewer than 3: return to Phase 1 with the new information.
- **3 or more failed fixes: stop fixing.** This usually means the design is wrong, not the hypothesis. Signs: each fix reveals a new problem somewhere else, fixes need large refactors, shared state or coupling keeps surfacing. Mark the card blocked and escalate to the Queen with what you tried, what each attempt showed and your question about the design. Do not attempt fix number 4 alone.

## Flaky and timing-dependent tests

Arbitrary sleeps cause flakes: they pass on fast machines and fail under load. Wait for the actual condition (an event, a state, a file, a count) with a timeout and a clear error. Use a fixed delay only when testing timing itself, and then document why that duration. Patterns: [references/condition-based-waiting.md](references/condition-based-waiting.md).

To find which test leaves pollution behind (a stray file, a changed global), run the test files one at a time and check for the artifact after each; the first one that creates it is the polluter. Bisect if the list is long.

## When there is truly no root cause

If investigation shows the cause is environmental, timing-dependent or external: document what you checked, add appropriate handling (retry, timeout, clear error message) and logging for next time. Be honest: most "no root cause" findings are incomplete investigations.

## Red flags: stop and go back to Phase 1

- "Quick fix for now, investigate later."
- "Just try changing X and see."
- Several changes at once, then running the tests.
- "Skip the test, I'll check by hand."
- "It's probably X" without evidence.
- Proposing fixes before tracing data flow.
- Adapting a pattern you have not read fully.
- "One more fix attempt" after two have failed.

Also stop if the Queen or a reviewer asks "is that actually happening?", "stop guessing" or "are we stuck?": you are assuming instead of verifying.

## Report (in the card result)

```
symptom:    what was observed, how to reproduce
evidence:   key log lines, traces, diffs (short)
root cause: the mechanism, with file:line
fix:        what changed and why it addresses the cause (or "none: investigation only")
proof:      failing-then-passing test, full-suite result, original symptom re-checked
risk:       anything unverified or environmental
```

## Done when

- [ ] Root cause named with evidence, not inferred from the symptom.
- [ ] A test reproduced the bug and failed before the fix.
- [ ] One fix at the source; test and full suite pass; symptom gone.
- [ ] Diagnostic logging removed; lesson written to the Brain.
