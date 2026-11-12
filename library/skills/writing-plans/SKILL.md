---
name: writing-plans
description: Turns an approved design or a multi-step goal into a wave of taskboard cards, each sized for one fresh insect, with dependencies, caste, priority and checkable acceptance criteria. Use after brainstorming is approved, or whenever a goal needs more than one task card, before any card is posted.
metadata:
  kind: skill
  castes: [queen]
  tags: [planning, taskboard, decomposition, waves, queen]
  version: 1
  status: vetted
  sources:
    - repo: obra/superpowers
      path: skills/writing-plans/SKILL.md
      license: MIT
    - repo: affaan-m/ecc
      path: agents/planner.md
      license: MIT
    - repo: the-insectoids/functions
      path: 02-hive.md (taskboard design, D5, D6, D7), 03-capabilities.md (D7, D8)
      license: internal
---

# Writing Plans

A plan is a set of task cards for insects who have never seen this project, this design or this conversation. Each card goes to a fresh insect with a clean context (03-D7), primed only by its Brain brief. What it cannot know is what you decided: which files, which names and signatures, which exact values, which checks prove the work. Write those down. Leave everything else to the insect's judgment.

## When to use

- After `brainstorming` produced an approved design, or the request is already clear but needs several cards.
- Not for a one-card job: post that single card directly (still with acceptance criteria).

## Before you write cards

1. **Scope check.** If the design covers several independent subsystems, make one plan per subsystem, each producing something that works and can be checked on its own.
2. **Gather context from the Brain** (`using-the-brain`): code map entries for affected files, current decisions, past outcomes and lessons for similar work. For unfamiliar ground, post a Scout card first and plan after its report.
3. **Map the parts.** List the files (or documents, datasets, assets) to create or change, and what each is responsible for. One clear responsibility per file; split by responsibility, not technical layer; things that change together live together. In existing projects follow established patterns; do not restructure unasked.
4. **Write the global constraints**: project-wide requirements (versions, dependency limits, naming and copy rules, platforms), one line each, exact values copied verbatim from the design. Every card inherits them.

## Plan in waves (02-D5)

- **Wave 1** = what you can specify with confidence now, plus cards that reduce uncertainty (spike, research, Scout).
- Do not plan past what you know. After a wave, read results, outcomes and Inspector findings, then plan the next wave.
- Order waves so each delivers something usable: smallest valuable slice first, then the complete happy path, then edge cases and polish, then optimization. Avoid plans where nothing works until everything is done.

## Card fields (match the taskboard, 02)

| Field | What you write |
|---|---|
| title | Short, specific, verb-first: "Add CSV export to report page" |
| brief | The task text: what to do, files, interfaces, exact values, steps, risks. The Brain adds decisions, lessons and context to make the full brief (01-E4). |
| goal_id | The user goal this card serves |
| depends_on | Card ids that must finish first (real dependencies only, see below) |
| skill | The caste needed: coder, tester, reviewer, researcher, documenter, designer, analyst, writer. Name up to 5 library skills to activate (03-D8). |
| priority | critical / high / normal / low |
| acceptance | How the Inspector knows it is done right (see below) |

Do not set `status`, `claimed_by`, `lease`, `attempts` or `result`; the board and harness own them.

**Priority:** critical = blocks the whole goal or fixes something broken for the user; high = on the critical path; normal = needed but not blocking; low = nice to have.

## Sizing a card: one fresh insect, one sitting

A card is the smallest unit that carries its own check and is worth a separate Inspector gate.
- Fold setup, config, scaffolding and docs into the card whose deliverable needs them.
- Split only where the Inspector could reasonably reject one part while approving its neighbor.
- One caste per card. If it needs a coder and a writer, it is two cards.
- **Too big** if: it touches many unrelated files, needs a design decision halfway through, or its acceptance takes more than a few lines.
- **Too small** if: it has no check of its own, or only makes sense together with another card.

## What a card's brief contains

A brief is good when the insect can produce exactly one reasonable thing from it: unambiguous, not exhaustive.
- **Files:** exact paths to create, modify (with line ranges when known) and test.
- **Interfaces:** *Consumes* (what earlier cards produce, exact names and types) and *Produces* (what later cards rely on). An insect sees only its own card; this is how it learns its neighbors' names.
- **Code step:** the exact signature and file; the insect writes the body. Include a body only for an algorithm the signature and tests do not determine, or for exact copy the design fixes.
- **Test step:** test name and assertions with the design's exact values; "write the failing test first" for code cards (`test-driven-development`).
- **Verification:** the command to run and the output that means it passed.
- **Non-code cards:** the deliverable, its audience, length or format limits, sources to use, and the check (e.g. "covers points A–D, under 300 words, cites the two decisions").
- **Risk:** one line if the card is risky (security, data loss, external side effects). It helps the router pick a stronger model (02-D9).

Lines that decide nothing are gaps: "TBD", "handle edge cases", "add validation", "write tests for the above", a name no card defines. A brief longer than the work it describes is a transcript: cut bodies back to signatures and tests.

## Acceptance criteria

Observable and checkable by the Inspector without asking anyone:
- commands with expected output ("`npm test -- export` passes, 6 tests");
- files or records that must exist, with key content;
- behavior a person can see ("downloading a 10k-row report finishes and opens in a spreadsheet");
- limits that must hold (no new dependencies, public API unchanged).

Avoid "works well", "clean code", "as expected".

## Dependencies

Add a `depends_on` edge only when a card:
- consumes an interface, file or result another card produces;
- edits the same file or record as another card (serialize them, or merge them into one card);
- needs a decision another card produces (research before build).

Everything else stays independent so it can run in parallel (`dispatching-parallel-work`). Check there are no cycles.

## Review focus

List the inputs or failure modes the design implies but no card's checks exercise and that would most likely hurt a real user (empty input, huge input, bad encoding, offline, duplicate submit...). Up to five, most likely first. For each, add the check to the card that owns the code.

## Self-review (do it yourself, then fix inline)

1. **Coverage:** every requirement in the design maps to a card. Add missing cards.
2. **Step scan:** every step decides something; nothing is a transcript.
3. **Interface consistency:** names and types match across cards (`clearLayers()` in one card and `clearAllLayers()` in another is a bug).
4. **Sizing and caste:** each card fits one fresh insect, has one caste, and has acceptance.
5. **Dependencies:** only real edges, no cycles, same-file edits serialized.
6. **Proportion:** the plan is not several times longer than the design.

## Approval and posting

- **Big goal:** the Queen shows the plan to the user (summary, waves, cards, risks) and waits for approval before posting (02-D5).
- **Small goal:** approved automatically.
- Cards that would do anything needing user approval (deleting data, spending money, publishing, pushing to a shared repo; 02-D7) say so in the brief, so the insect asks via the Queen instead of acting.
- Post cards through the taskboard tool (it goes through the Brain's single writer). Save the plan file in the project and a pointer to it in the Brain.

## Example card

```
title: Add CSV export endpoint
goal_id: G-12   depends_on: [T-31]   skill: coder (+ test-driven-development)
priority: high
brief:
  Files: create src/export/csv.ts; modify src/routes/report.ts:40-60;
         test tests/export/csv.test.ts
  Consumes: getReportRows(reportId: string): Promise<Row[]>  (from T-31)
  Produces: toCsv(rows: Row[]): string; GET /reports/:id/export.csv
  Steps: failing test "escapes commas and quotes" (a,"b" -> "a,""b""");
         implement toCsv; wire route; run `npm test -- export`.
  Risk: low.
acceptance:
  - `npm test -- export` passes (>= 4 tests incl. escaping and empty report)
  - GET /reports/1/export.csv returns text/csv with header row
  - no new dependencies
```

## Red flags

- Cards with no acceptance, or acceptance that needs the author to judge.
- A card that needs two castes or a mid-task design decision.
- Every card depends on the previous one when most could run in parallel.
- Planning wave 3 in detail before wave 1 has reported.
- Posting a big-goal plan before the user approved it.
