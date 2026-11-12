---
name: verification-before-completion
description: Evidence before any "done", "fixed" or "passing" claim. Turn the card's acceptance criteria into the smallest set of checks that proves them, run them fresh, read the output, and report exactly pass, fail, unavailable or blocked. Use as every insect's last step before submitting a card, and as the Inspector's method for checking finished work.
metadata:
  kind: skill
  castes: [all, inspector]
  tags: [quality, verification, evidence, review]
  version: 1
  status: vetted
  sources:
    - repo: obra/superpowers
      path: skills/verification-before-completion/SKILL.md
      license: MIT
    - repo: juliusbrussee/caveman
      path: skills/verify-and-stop/SKILL.md
      license: Apache-2.0
---

# Verification Before Completion

Evidence before claims, always. A claim of success without fresh proof is not optimism; it is a false report.

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

## When to use

- **Every insect:** as the last step before submitting a card for review, and before any message that says or implies work is done, fixed, passing or correct.
- **Inspector:** when checking a card in `review` before it may become `done`.
- Before committing, before handing off, before moving to the next card, and before trusting another agent's success report.

The rule covers paraphrases too: "should work now", "looks good", "all set", "great, that fixed it".

## The gate

```
BEFORE claiming any status:
1. IDENTIFY  which check proves this claim
2. RUN       the full check, fresh, after the last change
3. READ      the whole output: exit code, counts, warnings
4. COMPARE   does the output actually confirm the claim?
              no  -> report the real status with the evidence
              yes -> make the claim and attach the evidence
```

Skipping a step is not verifying.

## Step 1: turn acceptance into a proof set

Read the card's `acceptance` field and brief. For each criterion, write the smallest check that would prove it:

| Claim | Proof required | Not enough |
|---|---|---|
| Tests pass | Test command output: 0 failures, tests actually collected | An earlier run, "should pass" |
| Lint clean | Linter output: 0 errors | A partial run, extrapolation |
| Builds | Build command exit 0 | Lint passing, "logs look fine" |
| Types check | Typecheck command exit 0 | The editor showing no red |
| Bug fixed | Original symptom reproduced the original way, now gone | "Code changed, assumed fixed" |
| Regression test works | Red-green shown: fails without the fix, passes with it | Passes once |
| Requirements met | Each criterion checked one by one | "Tests pass, so done" |
| Another agent finished | The actual diff and files, checked | The agent's own report |
| Docs / research / design done | The artifact exists and covers each requested point | A summary saying it does |

Not every card is code. For documents, research and designs, the proof is opening the artifact and checking each criterion against it, quoting where each is met.

## Step 2: run checks narrow to wide

1. Focused checks first (the one test, the one file), so failures are cheap to read.
2. Then the wider gates the card or project needs: full test suite, typecheck, lint, build.
3. A result may be **reused** only if nothing has changed since it was produced (same files, same commit, same config). Any edit after the run makes it stale; run it again.

## Step 3: report status exactly

Use one of four words per criterion, never a blend:

- **pass**: the check ran and confirmed the criterion.
- **fail**: the check ran and showed it is not met. Quote the failure.
- **unavailable**: the check cannot run here (missing tool, no test framework, no access). Say what is missing.
- **blocked**: something outside the card prevents checking (dependency card not done, needs approval). Say what.

Never round "unavailable" up to "pass". Never hide a failing test you did not cause; name it.

## Step 4: stop

When every criterion has proof, stop. Do not add polish, cleanup, refactors or extra tests after the criteria pass. Do not edit product code during a verify-only card unless the card says to fix what you find.

## Inspector procedure

The Inspector decides whether a card in `review` becomes `done`. Check independently; the insect's report is a claim, not evidence.

1. Re-read the card: brief, acceptance, `depends_on` outputs.
2. Look at the actual changes (diff or produced files). Confirm they match the files the result lists, and that nothing unrelated changed.
3. Re-run the proof set yourself. Do not rely on output pasted in the result unless it provably matches the current state.
4. Check each acceptance criterion line by line and mark pass / fail / unavailable / blocked.
5. Check the work stayed in scope: no extra features, no deleted tests, no weakened checks (skipped tests, lowered thresholds, loosened types) unless the card asked for it.
6. If code changed and no review was done, run code-review (and security-review for auth, input handling, secrets or payments).
7. Verdict:
   - **accept**: every criterion passes. The card may be marked done.
   - **reject**: list each failing criterion with evidence and the exact gap. The card returns to the board and counts as an attempt.
   - **escalate**: criteria are ambiguous or contradict the brief, a check needs user approval, or the attempt limit is reached. Send to the Queen.

Approvals for destructive, costly or public actions (delete, spend, publish, push to shared repos) always go through the Queen; verification never grants them.

## Red flags: stop

- "Should", "probably", "seems to", "I'm confident".
- Satisfaction before running anything ("Done!", "Perfect!").
- About to submit, commit or hand off without a fresh run.
- Trusting a sub-agent's or insect's "success" without checking the diff.
- Partial verification standing in for the full check.
- "Just this once", "I'm out of budget", "the wording is different so the rule doesn't apply".

## Report format (card result or Inspector verdict)

```
card:      <id> <title>
criteria:
  1. <criterion>  pass         <command> -> <key output line>
  2. <criterion>  fail         <command> -> <failure line>
  3. <criterion>  unavailable  <what is missing>
checks:    <full-suite / typecheck / lint / build commands and results>
changed:   <files>
risk:      <anything unverified>
verdict:   submit | accept | reject | escalate
```

Keep it short: commands, results and unresolved risk. No narrative.

## Done when

- [ ] Every acceptance criterion has a fresh check and an exact status.
- [ ] Wider gates (suite, typecheck, lint, build as relevant) ran after the last change.
- [ ] Failures, gaps and skipped checks are named, not hidden.
- [ ] The claim made matches the evidence, and nothing beyond it.
