---
name: receiving-review-feedback
description: 'Handle review findings with technical rigor: read all of it, clarify anything unclear before changing code, verify each item against the codebase, push back with evidence when it is wrong, then fix one item at a time and test each. Use when a reviewer, the Inspector or the Queen returns findings on your card, before implementing any suggestion.'
metadata:
  kind: skill
  castes: [coder, tester, documenter, designer, writer]
  tags: [review, quality, feedback]
  version: 1
  status: vetted
  sources:
    - repo: obra/superpowers
      path: skills/receiving-code-review/SKILL.md
      license: MIT
---

# Receiving Review Feedback

Feedback is a set of claims to check, not orders to obey or a mood to manage. Verify before implementing. Ask before assuming. Technical correctness over social comfort.

## When to use

- A reviewer insect, the Inspector, or the Queen (passing on user feedback) returns findings on your card.
- Before changing any code in response to a finding, especially one that seems unclear or wrong.

## The response pattern

```
1. READ        all findings before reacting or changing anything
2. UNDERSTAND  restate each requirement in your own words, or ask
3. VERIFY      check it against the actual code, tests and docs
4. EVALUATE    is it technically right for THIS codebase?
5. RESPOND     short technical acknowledgment, or reasoned pushback
6. IMPLEMENT   one item at a time, test each
```

## Unclear items: stop first

If any item is unclear, do not implement anything yet. Items are often related; partial understanding leads to wrong fixes.

```
Wrong: fix items 1, 2, 3, 6 now and ask about 4 and 5 later.
Right: "Understood 1, 2, 3, 6. Need clarification on 4 and 5 before changing anything."
```

Ask through the card (or the reviewer's thread). Mark the card blocked if the answer must come from the Queen.

## Trust by source

**The Queen (including user feedback she relays):** trusted on intent and priorities. Still ask if the scope is unclear. Just act; no performative agreement.

**Reviewer insects and the Inspector:** be skeptical, but check carefully. Before implementing, check:
1. Is it technically correct for this codebase and stack?
2. Would it break existing behavior or tests?
3. Is there a reason the current code is the way it is (compatibility, a past bug, a documented decision in the Brain)?
4. Does it hold on all supported platforms and versions?
5. Did the reviewer see the full context?

Cannot verify it? Say so: "Can't verify this without X. Should I investigate, ask, or proceed?"

Conflicts with an earlier decision by the Queen or the user? Stop and escalate to the Queen before changing anything.

## The YAGNI check

When a reviewer asks to "implement this properly" (add metrics, options, export formats, abstractions), search the codebase for real usage first.

- Unused: "Nothing calls this endpoint. Remove it instead (YAGNI)? Or is there usage I'm missing?"
- Used: implement it properly.

Neither you nor the reviewer decides to add features the card did not ask for; that goes to the Queen.

## When to push back

Push back when the suggestion:
- breaks existing functionality,
- comes from missing context,
- adds an unused feature,
- is wrong for this stack or version,
- ignores compatibility or legacy constraints,
- conflicts with a decision by the Queen or the user.

How: technical reasoning, specific questions, and evidence: a passing test, a code reference, a doc line. Not defensiveness. Architectural disagreements go to the Queen.

Example:

```
Reviewer: "Remove the legacy fallback."
You: "Checked: build target supports version 10.15+, this API needs 13+.
      The fallback is still required. The fallback does have a wrong bundle id
      (config.ts:31). Fix that, or drop pre-13 support? Escalating the support
      question to the Queen."
```

If a disagreement does not resolve after one exchange, record both positions in the card result and escalate. Do not loop.

## Implementation order

1. Clarify everything unclear first.
2. Then fix in this order:
   - blocking issues (critical and high: breakage, security),
   - simple fixes (typos, imports, small guards),
   - complex fixes (logic changes, refactors).
3. Test each fix on its own. Use test-driven-development for behavior changes: a failing test first.
4. Run the full suite at the end; no regressions.
5. Run verification-before-completion before resubmitting.

## How to respond

When the feedback is right:

```
Good: "Fixed: null guard added before .email (session.ts:88), test added."
Good: "Fixed in src/api/users.ts:42, query now parameterized."
Good: just fix it; the diff shows you heard it.
```

Never: "You're absolutely right!", "Great point!", "Thanks for catching that!", or any gratitude or flattery. State the fix instead. Actions show you heard the feedback.

When your pushback was wrong:

```
"Checked again: you're correct, X does Y because Z. Fixing now."
```

No long apology, no defending why you pushed back. State the correction and move on.

## Common mistakes

| Mistake | Instead |
|---|---|
| Performative agreement | Restate the requirement, or just act |
| Blind implementation | Verify against the codebase first |
| Batching many fixes, testing once | One at a time, test each |
| Assuming the reviewer is right | Check whether it breaks things |
| Avoiding pushback | Correctness over comfort |
| Implementing the clear half, guessing the rest | Clarify all items first |
| Proceeding on something you cannot verify | State the limit, ask for direction |

## Report (in the card result)

One line per finding, same ids or locations the reviewer used:

```
<path:line or finding #>: fixed | pushed back | needs answer | deferred (follow-up card) . <what changed, or the evidence>
```

Then the verification evidence for the resubmission.

## Done when

- [ ] Every finding has a status: fixed, pushed back with evidence, needs answer, or deferred with a reason.
- [ ] Each fix tested on its own; full suite green.
- [ ] Unresolved disagreements and scope questions escalated to the Queen, not silently dropped.
