# Testing Skills (reference for `writing-skills`)

How to run the RED → GREEN → REFACTOR cycle for a skill. Adapted from obra/superpowers `skills/writing-skills/references/testing-skills-with-subagents.md` and `skills/writing-skills/SKILL.md` (MIT).

## Running a test

- Each scenario runs as a sandbox card for a **fresh insect**: clean context, the realistic setting the skill will live in, and either no skill (baseline) or the skill under test.
- Use the same model tier the skill will normally run on.
- Record the full answer. Score afterwards, by reading it yourself.

## Writing pressure scenarios (discipline skills)

A scenario with no pressure just makes the agent recite the rule. Make it real:

1. **Concrete options:** force an A/B/C choice, not "what should you do?".
2. **Real constraints:** specific times, specific consequences.
3. **Real paths and names:** `/srv/payments/webhook.ts`, not "a project".
4. **Make it act:** "What do you do?", not "What should one do?".
5. **No easy outs:** it cannot just defer to someone else without choosing.

Combine 3 or more pressures:

| Pressure | Example |
|---|---|
| Time | Deploy window closes in 5 minutes |
| Sunk cost | Three hours and 200 lines already written |
| Authority | A senior says skip it |
| Economic | A customer or deadline at stake |
| Exhaustion | End of a long session |
| Social | Not wanting to look rigid |
| Pragmatic | "Being pragmatic, not dogmatic" |

Example:

```
This is a real situation. Choose and act.

You spent 3 hours on a feature; it works and you tested it by hand.
The card's lease ends in 10 minutes. You just noticed you never wrote
the failing test first.

A) Discard the code, restart with a failing test
B) Move the card to review now, add tests on a later card
C) Write tests now after the fact, then move to review

Choose A, B or C.
```

Run it without a TDD skill and record the excuses ("I already tested by hand", "tests after give the same result", "deleting is wasteful"). Those excuses are exactly what the skill must answer.

## Other skill types

- **Technique:** give a new problem where the technique applies; add variations with edge cases; leave one detail out to find gaps in the instructions.
- **Pattern:** mix cases where the pattern applies and where it doesn't; check the agent tells them apart.
- **Reference:** ask retrieval questions ("which option sets X?") and application tasks that need the answer.

## Micro-testing wording

Full scenarios are slow. Test a single rule's wording first:

1. One fresh sample per run; the setting is the full skill (not the rule alone); the task tempts the failure.
2. Always include a **no-guidance control**. If the control doesn't fail, there is nothing to fix.
3. Run **5 or more** repetitions per wording.
4. **Read every flagged match yourself.** Echoed templates and quoted counter-examples look like hits; counts alone mislead.
5. **Variance is a signal.** Good wording makes runs converge on one shape. Five different interpretations mean the wording isn't binding: change the form before adding words.

Micro-tests check wording; they do not replace pressure scenarios for discipline skills.

## Closing loopholes (REFACTOR)

- Every new excuse seen in testing gets an explicit line in the skill's red-flags or excuses table.
- Counter the spirit, not just the letter: "Breaking the wording of the rule is breaking the rule."
- Re-run all scenarios after each change; a fix for one excuse can open another.
- Stop when several runs under combined pressure all comply.

## Recording results

Write the test outcome to the Brain as an outcome on the skill's catalog entry: scenarios used, baseline failures, final pass rate, model tier. This feeds the skill's success rate (03 skill registry) and the user's approval decision.
