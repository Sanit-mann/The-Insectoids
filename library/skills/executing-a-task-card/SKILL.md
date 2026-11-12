---
name: executing-a-task-card
description: Takes one claimed task card from its Brain brief to a verified result and a handoff, staying inside the card's scope and escalating instead of guessing. Use whenever an insect starts or resumes work on a taskboard card, of any caste.
metadata:
  kind: skill
  castes: [all]
  tags: [execution, taskboard, scope, escalation, handoff]
  version: 1
  status: vetted
  sources:
    - repo: obra/superpowers
      path: skills/executing-plans/SKILL.md
      license: MIT
    - repo: obra/superpowers
      path: skills/subagent-driven-development/SKILL.md
      license: MIT
    - repo: obra/superpowers
      path: skills/subagent-driven-development/implementer-prompt.md
      license: MIT
    - repo: the-insectoids/functions
      path: 02-hive.md (taskboard, D4, D7), 01-memory.md (E2, E4), 03-capabilities.md (D7)
      license: internal
---

# Executing a Task Card

One insect, one card. The plan already did the thinking: execute the card exactly, prove each step, report a result the Inspector can check, and leave a handoff the next agent can resume from. Bad work is worse than no work; escalating is never penalized.

## Your starting context

You are a fresh insect (03-D7). The harness has claimed the card for you, renews its lease while you work, and injected:
- the **boot card** (current goals, recent decisions, lessons);
- the **task brief** (01-E4): card text, acceptance, global constraints, relevant decisions, files, past outcomes;
- a **handoff** (01-E2) if this card was started before.

The harness records your progress and heartbeats. Do not spend tokens writing status updates.

## 1. Read the brief (see `task-handoff`)

- Read **acceptance first**: it defines done.
- Then the task text, interfaces (*Consumes* / *Produces*), and global constraints. Note exact values; use them verbatim.
- Decisions in the brief are binding. Lessons are "don't do X" rules.
- Check the card matches your caste. If not, stop and report it.
- **Resuming?** Steps the handoff marks done with evidence are done: do not redo them. Trust result records and commit history over assumptions. Start at its "next step".

## 2. Pre-flight

Before changing anything, ask: can I meet every acceptance line with what I have?
- Missing information: look it up in the Brain by tier (`using-the-brain`), then the specific source file. Do not read the whole project.
- Still missing, or the brief contradicts itself or a decision: report **NEEDS_CONTEXT** now, before starting (step 6).

## 3. Work the steps in order

- Code cards follow `test-driven-development`: write the failing test, watch it fail for the right reason, then implement.
- Every step that runs a command has an expected result. Run it, read the output, compare. Three outcomes:
  - **Matches:** next step.
  - **Your work is wrong:** use `systematic-debugging`. Fix the cause; never patch the symptom to make output match.
  - **The brief is wrong** (an interface doesn't match, a command can't work, a step contradicts a decision): if the fix is small, reversible and inside your card, make the smallest change that satisfies the design and record it as `Ruling: <what you decided> — <why> — <cost if wrong>`. If it changes an interface other cards use, touches another card's files, or changes scope, escalate.
- Keep context lean: send long command output to a file and read the tail; read the parts of files you need, not whole trees.

## 4. Stay in scope

- Build only what the card asks. No extra features, no "while I'm here" refactors, no restructuring outside the card (`coding-discipline`).
- Found a real problem outside your card? Do not fix it. Note it under **Findings** in your result; the Queen decides whether it becomes a new card.
- Do not spawn helpers to do your card or reviewers to check it. Review is the Inspector's job.
- Do not start another card in this context. When you finish, the harness gives the next card to a fresh insect.

## 5. Actions that need approval

Never do these yourself, even if the brief seems to allow them (02-D7): delete files or data, spend money, publish or post anything public, push to a shared repository, or anything else destructive, costly or public. Set the card to **blocked** with an approval request (what, why, exact effect). The Queen asks the user. Only the Queen talks to the user (02-D4).

## 6. Stop and escalate when

- the card needs an architectural or design decision with several valid answers;
- you need to understand code or material beyond the brief and cannot find clarity in the Brain;
- you are unsure whether your approach is correct;
- the work needs restructuring the plan did not anticipate;
- you have read file after file without progress, or hit the same error twice with no new information.

**How:** set the card to **blocked** with status `BLOCKED` (cannot complete) or `NEEDS_CONTEXT` (missing information), and say specifically what you are stuck on, what you tried, and what help you need. Write a handoff. The Queen or Foreman can add context, retry with a stronger model (02-D9), or split the card. Do not keep retrying the same thing; the board's attempt limit escalates for you.

## 7. Self-review before reporting

Read your own output with fresh eyes and fix what you find:
- **Completeness:** every acceptance line met? every requirement in the brief? edge cases named in the brief?
- **Quality:** names say what things do; follows the project's existing patterns.
- **Discipline:** nothing built that wasn't asked (YAGNI).
- **Tests:** they check real behavior, not mocks; output is clean (no stray warnings).

## 8. Completion contract

Before you claim done, all of these are true **with evidence from this session** (`verification-before-completion`), not inferred from the diff looking right:
- every test or check the brief names exists, ran, and you read its output;
- the final full run for the card passed;
- every expected result in the brief was compared against real output;
- every deviation from the brief has a `Ruling:` line.

If any item is missing, the card is not done. Finish it.

## 9. Report the result

Write the card's `result` (short, `compact-output` style), then move the card to **review**. The Inspector moves it to done or sends it back; you never mark your own card done.

```
Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
Summary: <one or two lines: what now exists or changed>
Files: <paths changed, commits if any>
Checks: <command> -> <result>   (e.g. npm test -- export -> 6/6 pass)
Rulings: <each Ruling: line, or "none">
Concerns: <doubts about correctness or scope, or "none">
Findings: <out-of-scope problems noticed, or "none">
```

Use **DONE_WITH_CONCERNS** when the work is complete but you doubt part of it. Never silently hand over work you are unsure about.

## 10. Write to the Brain (`using-the-brain`)

- **Outcome** (automatic trust): approach, result, success or failure, and a lesson line if something failed ("don't do X because Y").
- **Updates** (automatic): what changed, where.
- **Facts** you learned: as *unconfirmed*, with confidence and source. **Decisions**: only as proposals.
- **Handoff:** a final checkpoint (`task-handoff`), so a retry or the next wave starts from ~200 tokens.

## If the Inspector sends it back

Fix only the listed findings. Re-run the checks that cover the changed work. Append a short fix report to the result (what changed, command, output) and move the card to review again. New problems in code you did not touch go under Findings, not into this fix.

## Red flags

| Thought | Reality |
|---|---|
| "I remember what the brief says" | You remember a summary. Re-read the exact values. |
| "The test obviously passes, skip running it" | "Should pass" is not evidence. Run it and read the output. |
| "The brief is wrong, I'll quietly do it right" | Fine if small and in scope, but record the Ruling. Unrecorded deviation is a secret decision. |
| "I'll fix this unrelated bug too" | Scope creep. Add it to Findings. |
| "I'll just push / delete / publish, it's tiny" | Needs user approval via the Queen. Block and ask. |
| "One more try with the same approach" | If nothing changed, it will fail the same way. Escalate. |
| "I'll mark it done myself" | The Inspector decides done. Move it to review. |
