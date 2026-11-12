---
name: using-the-brain
description: Reads the shared Brain in tiers (boot card, index, detail, source file) within a token budget, and writes updates, outcomes, facts and decision proposals at the right trust level, deduped and free of secrets. Use at the start of any task, before reading raw files or chat history, and whenever you finish something worth remembering. Every agent.
metadata:
  kind: skill
  castes: [all]
  tags: [brain, memory, tokens, trust, secrets]
  version: 1
  status: vetted
  sources:
    - repo: the-insectoids/functions
      path: 01-memory.md (design, A1-A6, E1-E16, D2, D3, D5, D7, D8, D9, D14)
      license: internal
    - repo: the-insectoids/functions
      path: 02-hive.md (D3, taskboard)
      license: internal
---

# Using the Brain

The Brain is the hive's shared memory: one local SQLite database holding files, decisions, updates, tasks, facts, agent notes, outcomes and the links between them. Querying it is far cheaper than re-reading chats, code or documents. Read only what you need, in the smallest form; write what the next agent will need, at the right trust level.

## How you reach it

The Brain has three doors with the same operations (01-D5): an **MCP server**, a **`brain` command-line tool**, and a **local HTTP API**. Use whichever your tool supports. The operation names below are generic; map each to the matching MCP tool, CLI command or API call.

| Operation | Use it to |
|---|---|
| brain boot | Get the boot card (usually injected for you at start) |
| brain search "<question>" [budget] | Keyword + meaning search; returns index rows packed to the budget |
| brain get <id> | One full record (detail) |
| brain codemap <file> | Functions, classes, callers and purpose of a code file |
| brain write update / outcome / note / handoff | Record what changed, how a task went, your own notes, a checkpoint |
| brain write fact | Add an unconfirmed fact with confidence and source |
| brain propose decision | Propose a decision for the user to approve |
| brain link <a> <b> | Record a real link between two records |
| brain flag <id> | Mark a record stale, conflicting or sensitive for the Librarian |

## Where you look: shelves (01-D2)

Load only the **current project shelf**, the **global shelf** (preferences, style, lessons) and **your own agent shelf**. Don't search other projects unless the card says so.

## Reading in tiers: stop at the first tier that answers

1. **Boot card** (a few hundred tokens): current goals, active tasks, recent decisions, lessons. The harness injects it when you start (01-E1).
2. **Index rows:** titles and one-line summaries from `brain search`. Often enough on their own.
3. **Detail:** `brain get` one full record, only for the rows you actually need.
4. **Source:** open the real file only as a last resort, and only the part you need. Use the code map first to find the function or line range (01-E3).

Search before you ask anyone, and before you read raw files or chat history. For "why was this done?", look in decisions: they carry the reason and the alternatives.

## Budget-sized answers (01-D7, E8)

- Default answer budget: **~800 tokens**. Ask for "the best 800 tokens on X", not "everything about X".
- Ask for more only with a reason (e.g. a review that needs every decision on a module).
- On small-context models, keep each answer to about **5% of the model's context window** or less.
- Ask narrow questions. "How does export escape quotes?" beats "tell me about export".

## Judging what you read

- **Decisions:** use only current ones (no end date; 01-E9). Superseded ones are history, not rules.
- **Facts:** each has confidence and source (01-D3). Confirmed facts are reliable; unconfirmed ones are hints to check before risky use.
- **File summaries:** carry a content hash. If one is flagged stale, read the source and `brain flag` it if it's wrong.
- **Conflicts:** if two records disagree, don't pick one silently. Flag it; the user resolves conflicts.
- **Privacy (01-D8):** whatever you read is sent to your model's provider as part of your prompt. Pull only what the task needs.

## What to write, and at which trust level (01-D3)

| What | Trust level | Example |
|---|---|---|
| Updates (what changed, where) | Written automatically | "Added toCsv() in src/export/csv.ts" |
| Outcomes (approach, result, success or failure, lesson) | Automatically | "CSV export: plain join, 6/6 tests, 1 retry. Lesson: Row not RowDTO" |
| Card result and status changes | Through the taskboard tool | Move to review with result |
| Your own notes and handoffs | Automatically, on your shelf | See `task-handoff` |
| Facts | Unconfirmed, with confidence and source; confirmed later by the user or repeated evidence | "Reports API returns max 10k rows (0.7, from src/api/reports.ts:88)" |
| Decisions | **Proposal only**: what, why, alternatives. The user approves | "Use plain join for CSV; streaming was slower" |

Lessons: put a "don't do X because Y" line in failure outcomes; the Librarian promotes repeated ones to the lessons register (01-E10).

**Don't write:** progress or heartbeat status (the harness records it for free); chat transcripts; raw tool output; whole file contents; guesses dressed as facts; anything already stored.

## Writing rules

- **All writes go through the single writer (01-D14).** Never open or edit the database file directly. If a write is rejected because the record changed meanwhile, re-read it, re-apply your change to the new version, or flag the conflict. Never force it.
- **Dedupe before writing (01-E5).** Search for a near-identical record first. If one exists, update it (a new version) or merge into it instead of adding a copy.
- **Route, don't copy (A1).** Store a short summary plus a pointer (path, line range, commit, record id), never the full content.
- **Never delete, never silently overwrite.** Changes become new versions; old material is archived, not removed. To retire something, flag it for the Librarian.
- **Link only real connections (A6):** a card to the files it changed, a decision to the card that applied it. No invented links.
- **Plain, model-neutral text** plus structured fields; one idea per record; compact (`memory-compression` style for summaries).

## Never store secrets (01-E6)

Never write API keys, passwords, tokens, private keys, credentialed connection strings, or personal ID numbers, in any record, note, handoff or result. Write a pointer instead: "key: kept in the user's secret store as REPORTS_API_KEY". If you find a secret already in a record, don't repeat it anywhere; `brain flag` the record as sensitive.

## Quick reference

```
start:    boot card -> brain search "<card topic>" -> get only needed rows
          -> codemap -> open source lines last
during:   search before asking; checkpoint handoffs at milestones
finish:   update + outcome (+ lesson) -> facts as unconfirmed
          -> decisions as proposals -> final handoff
always:   ~800 tokens default | dedupe first | pointers not copies
          | no secrets | single writer | never delete
```

## Red flags

| Thought | Reality |
|---|---|
| "I'll just read the whole folder to be safe" | Search the Brain first; open only the lines you need. |
| "Give me everything on the project" | Ask a narrow question with a budget. |
| "I'm sure of this, I'll record it as a decision" | Agents only propose decisions. The user approves. |
| "I'll add a new note, quicker than searching" | Dedupe first; update the existing record. |
| "I'll write the status every few minutes" | The harness records progress. Write outcomes, not heartbeats. |
| "The key is needed later, I'll store it" | Never. Store where it lives, not the secret itself. |
| "I'll fix the row directly in SQLite" | All writes go through the single writer. |
