---
name: task-handoff
description: Writes the short "done / where I left off / next step / blockers" checkpoint that lets the next agent resume a card in about 200 tokens, and reads a Brain task brief or handoff correctly before starting. Use when starting or resuming a card, before a session ends or its context is compacted, when blocked or escalating, and when finishing a card.
metadata:
  kind: skill
  castes: [all]
  tags: [handoff, checkpoint, brief, resume, brain]
  version: 1
  status: vetted
  sources:
    - repo: the-insectoids/functions
      path: 01-memory.md (E1, E2, E4, D3, D5, D14), 02-hive.md (taskboard), 03-capabilities.md (D7)
      license: internal
    - repo: obra/superpowers
      path: skills/subagent-driven-development/SKILL.md
      license: MIT
    - repo: obra/superpowers
      path: skills/executing-plans/SKILL.md
      license: MIT
---

# Task Handoff

Every insect starts fresh (03-D7). What it knows comes from two Brain records: the **task brief** (01-E4), assembled by the Brain when a card is handed out, and the **handoff** (01-E2), the last checkpoint written by whoever worked the card before. This skill covers writing a good handoff and reading both.

## Part 1: Writing a handoff checkpoint

### When to write one

- At natural milestones in a long card (a step verified, a commit made). If you are stopped abruptly, the last checkpoint is all that survives.
- Before your session ends or your context is compacted. The harness asks for the handoff when it stops an agent (01-D5); have it ready.
- When you block or escalate: the person unblocking you reads it first.
- When you finish: a final checkpoint for retries and the next wave.
- When the Watchdog steers or stops you, or your lease is about to expire.

### Format (aim for ~200 tokens)

```
Card: T-42 "Add CSV export endpoint"   attempt: 2   status: in progress
Done (verified):
  - toCsv() + 5 tests; `npm test -- export` -> 5/5 pass; commit a1b2c3d
Where I left off: src/routes/report.ts:52, wiring GET /reports/:id/export.csv
Next step: add route test "returns text/csv with header row", watch it fail
Blockers: none   |   Waiting on: -
Rulings: kept Row type from T-31 as-is (brief said RowDTO; T-31 produced Row)
Don't redo / dead ends: streaming writer was slower on 10k rows; plain join is fine
Pointers: plan docs/plans/2026-11-12-export.md; Brain decision D-77
```

### Rules

- **Verified vs assumed.** "Done" lists only what you checked in this session, with the evidence (command and result, commit, file). Anything else goes under Next step or is marked "unverified".
- **One concrete next step**, specific enough to act on without rereading everything.
- **Blockers name who must act:** the Queen, the user (via the Queen), or another card.
- **Facts, not narrative.** No story of how you got here; no pasted logs, diffs or files. Point to them (route, don't copy).
- **Record dead ends** so the next agent doesn't repeat them.
- **No secrets.** Never put keys, passwords or tokens in a handoff; name where they are kept instead (01-E6).
- **One live handoff per card.** Write a new version of the card's handoff rather than adding a second record (01-E5). History is kept automatically.
- Handoffs are your own notes, so they are written automatically (01-D3), through the Brain's single writer (01-D14), like every other write.

## Part 2: Reading a task brief

The brief is your single source of requirements. What you remember of it is a summary; the brief has the exact values.

### What a brief contains

- The card: title, task text, acceptance, caste, priority, `depends_on` and the results of those cards.
- Global constraints for the goal.
- Relevant **current** decisions (binding), facts (with confidence), file and code-map entries.
- Past outcomes and lessons for similar work.
- The latest handoff, if the card was worked before.
- Which library skills are active for this card.

### How to read it

1. **Acceptance first.** It defines done. If you can't tell how the Inspector will check it, that is a gap.
2. **Task text and interfaces.** Note what you *consume* from earlier cards and what you must *produce* for later ones; names and types must match exactly.
3. **Copy exact values verbatim** (numbers, strings, signatures, paths). Don't paraphrase them.
4. **Decisions are binding; lessons are rules.** A decision the work seems to contradict is a reason to escalate, not to override.
5. **Unconfirmed facts are hints.** Check them before relying on them for anything risky.
6. **List the gaps.** For each, look it up in the Brain by tier (`using-the-brain`) before opening source files.
7. **Still unclear?** Escalate with `NEEDS_CONTEXT` before you start changing things (`executing-a-task-card`).

## Part 3: Resuming from a handoff

1. Read the brief, then the handoff.
2. **Don't redo** steps listed as done with evidence. Records (results, commits, Brain updates) beat anyone's memory, including yours after compaction.
3. **Spot-check the riskiest "done" claim** cheaply (e.g. run the one named test) before building on it.
4. **If the handoff disagrees with the brief or the actual files**, the brief and the files win. Note the mismatch under Rulings.
5. Start at the handoff's **Next step**. Respect its dead ends.

## For the Queen: adding to a brief

The Brain assembles the brief; when you hand a card out you may add a short note. Keep it to:
- one line on where the card fits in the goal;
- interfaces and decisions from earlier cards the brief can't know yet;
- your resolution of any ambiguity you noticed.

Describe one card, not the session's history. Never paste summaries of earlier cards ("state after T-1 to T-5"): a fresh insect needs its card, its interfaces and the constraints, nothing more.

## Red flags

| Thought | Reality |
|---|---|
| "I'll write the handoff at the end" | Sessions get cut off. Checkpoint at milestones. |
| "Tests probably pass, I'll list it as done" | Unverified work goes under Next step, marked unverified. |
| "I'll paste the log so they have everything" | Point to it. The next agent reads ~200 tokens, not 5,000. |
| "I remember the brief" | You remember a summary. Re-read the exact values. |
| "The handoff says done, so it's done" | Spot-check the riskiest claim before building on it. |
