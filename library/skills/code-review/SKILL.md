---
name: code-review
description: 'Review a code change for real problems only (correctness, security, maintainability, performance, tests), filtered by confidence, no style nitpicks, reported one line per finding as `path:line: severity: problem. fix.` with a clear verdict. Use when reviewing a diff, branch or card result, and when requesting a review of your own finished work.'
metadata:
  kind: skill
  castes: [reviewer, coder, inspector]
  tags: [review, quality, code-review]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: agents/code-reviewer.md
      license: MIT
    - repo: msitarzewski/agency-agents
      path: engineering/engineering-code-reviewer.md
      license: MIT
    - repo: obra/superpowers
      path: skills/requesting-code-review/SKILL.md
      license: MIT
    - repo: obra/superpowers
      path: skills/requesting-code-review/code-reviewer.md
      license: MIT
    - repo: juliusbrussee/caveman
      path: skills/caveman-review/SKILL.md
      license: Apache-2.0
---

# Code Review

Find the problems that would cause bugs, breaches, data loss or pain later. Say each one in one line with the exact location and a concrete fix. Skip everything else.

A clean review with zero findings is a valid, expected result. Manufactured findings, filler nits and speculative "consider X" are the main failure mode of AI reviewers.

## When to use

- **Reviewer:** any review card, diff, branch or file set.
- **Coder (requesting):** after finishing a card that changes code, after a complex bug fix, before anything is merged into a shared branch.
- Language add-ons: typescript-review, python-review. Security-heavy changes (auth, input handling, secrets, payments, uploads, webhooks): also security-review.

## Requesting a review

Post a review card (or hand off to the reviewer) with exactly the context needed, never your whole session history:

- **What was built:** one or two sentences.
- **Requirements:** the original card id, brief and acceptance criteria.
- **Range:** base and head (commit ids, branch, or the list of changed files).
- **Checks already run:** commands and results.

Template: [references/review-request.md](references/review-request.md). Act on the result with receiving-review-feedback: fix critical and high first, push back with evidence when the reviewer is wrong.

## Review process

1. **Gather the change.** Read the full diff for the given range. No range given: staged and unstaged changes, else the last commit.
2. **Check readiness.** If the card says checks are failing or the branch has conflicts, report that and stop; review green code.
3. **Understand intent.** Read the card's brief and acceptance. Note where the code departs from them.
4. **Read context.** Whole changed files, their callers, imports and tests. Many apparent issues are handled one frame up or prevented by a type.
5. **Run cheap checks** if the project has them (tests, typecheck, lint). Read-only: never edit the code, never move the branch, never spawn another reviewer.
6. **Apply the checklist** below, most severe first.
7. **Filter** every candidate finding through the gate.
8. **Report** in one pass. Complete feedback once; no drip-feeding across rounds.

## Confidence gate

Before writing a finding, answer all four. Any "no" or "unsure": downgrade it or drop it.

1. **Exact line?** File and line. "Somewhere in auth" is not a finding.
2. **Concrete failure?** The input or state that triggers it and the bad outcome. No trigger means pattern-matching, not reviewing.
3. **Context read?** Callers, guards, types and tests checked.
4. **Severity defensible?** Inflated severity destroys trust faster than a missed finding.

Report only what you are more than 80% sure is a real problem. **Critical** and **high** also need: the snippet, the failure scenario (input, state, outcome), and why existing guards do not catch it. Cannot produce all three: demote to medium or drop.

Also:
- Skip issues in unchanged code unless critical security.
- Consolidate repeats ("5 handlers swallow errors: a.ts:10, b.ts:22, ...") into one finding.
- Ask "would a senior engineer on this team change this in review?" If no, skip.

## Checklist

**Correctness.** Logic errors, wrong conditions, off-by-one, null or missing-value paths that can actually occur, broken API contracts, race conditions, missing error handling on critical paths (unhandled rejections, empty catch blocks), data loss or corruption, departures from the card's requirements, and behavior a reasonable user would expect even where the spec is silent.

**Security.** Hardcoded secrets, injection (SQL, shell, template), XSS, path traversal, missing authentication or authorization checks, CSRF on state-changing endpoints, secrets or personal data in logs, internal error details sent to clients, known-vulnerable dependencies. Go deeper with security-review.

**Maintainability.** Functions doing several unrelated things (roughly over 50 lines with real complexity), nesting deeper than 4 levels, duplicated logic that will drift, dead code, debug output left in, unclear names in non-trivial code, hidden coupling or architecture drift, changes outside the card's scope.

**Performance.** N+1 queries, unbounded queries on user-facing paths, quadratic work where linear is easy, blocking I/O in async paths, missing timeouts on external calls, repeated expensive work without caching. Only when the path is hot or the data is large.

**Tests.** New behavior without tests, tests that assert on mocks instead of behavior, missing edge or error cases, skipped or deleted tests, weakened assertions or thresholds.

Full list with examples and the common false positives to skip: [references/checklist.md](references/checklist.md).

**Do not report:** formatting, quote style, import order or naming taste that a linter or the project's conventions already handle; personal preferences; "should use a different language or library".

## Severity

| Level | Meaning | Card impact |
|---|---|---|
| `critical` | Security hole, data loss, crash on a normal path | Blocks. Must fix. |
| `high` | Real bug or serious risk with a named trigger | Must fix before done. |
| `medium` | Fragile or costly, works today | Fix or record as follow-up. |
| `low` | Small improvement worth knowing | Optional. Use sparingly. |
| `q` | Genuine question about intent | Answer needed, not a change request. |

## Output format (default for agent-to-agent reviews)

One line per finding:

```
path:line: severity: problem. fix.
```

Examples:

```
src/api/users.ts:42: critical: email interpolated into SQL string. Use parameterized query with email as a bound value.
src/auth/session.ts:88: high: user can be null after find() on unknown id. Guard and return 401 before reading .email.
src/jobs/sync.ts:23: medium: no retry on 429 from upstream. Wrap call in existing withBackoff(3).
src/cart/total.ts:15-60: low: one function validates, prices and persists. Extract pricing into its own function.
src/flags.ts:7: q: is the flag meant to default to on in production?
```

Rules: exact line or range, symbol names in backticks when helpful, concrete fix (not "consider refactoring"), the "why" only when the fix does not make it obvious. No hedging ("maybe", "I think"): if unsure, use `q` or drop it. No restating what the code does. No per-finding praise.

**Write a short paragraph instead** for critical security findings (explain the attack and reference the class, e.g. CWE or OWASP category) and for design disagreements (give the reasoning). Then return to one-liners.

## Report structure

```
review: <card id or range>  files: <n>  checks: <commands run and results>
strengths: <optional, one line, only if specific>
<findings, most severe first>
declined: <behaviors considered and set aside as out of scope, one line each with reason>
verdict: approve | changes-requested | block
```

- **approve:** no critical or high findings. Zero findings is fine.
- **changes-requested:** at least one high, no critical.
- **block:** at least one critical.

Do not withhold approval to look rigorous. For a human-facing report (relayed by the Queen), use the same findings but full sentences.

## Done when

- [ ] Whole diff and its context read; checks run or noted as unavailable.
- [ ] Every finding passed the confidence gate and has line, problem and fix.
- [ ] Nothing manufactured; repeats consolidated; no style nits.
- [ ] Clear verdict recorded in the card result.
