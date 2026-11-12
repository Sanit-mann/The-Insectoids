# Phase 1 "First Spark": Implementation Plan

**Branch:** `phase-1-first-spark` · **Started:** 2026-11-12 · **Spec:** [functions/10-build-roadmap.md](../../functions/10-build-roadmap.md)

**Goal:** one goal goes all the way through the hive, safely.
1. You give the Queen a goal and approve her plan.
2. Coder and Tester insects work in parallel in separate git worktrees.
3. The Inspector verifies the work.
4. You approve the merge, then undo and redo it.
5. The Brain shows every decision, task and outcome.

Each step ends in something that works and is tested. Core services are built test-first.

## Technical findings that shape the plan (2026-11-12)

- **Brain database: Node's built-in `node:sqlite`.** It works inside Electron 45, which runs Node 24.22 with SQLite 3.53.4 and FTS5 full-text search. This replaces `better-sqlite3`, the native module from the tech-stack spec, and removes the need to rebuild it for each Electron version. It sits behind a small adapter, so switching back stays easy. Recorded as 09-D8.
- **Claude Code CLI is not installed on this PC.** Steps 1–4 don't need it. Step 5 asks the user to install it, with consent (04-D6).

## Steps

| # | Step | Package | Done when |
|---|---|---|---|
| 1 | **Brain core** (details below) | `packages/brain` | Unit tests cover every rule |
| 2 | **Taskboard store**: cards in the Brain; atomic claim; leases with expiry sweep; retry then escalate; dependency locking (uses `@insectoids/shared` rules) | `packages/brain` | Concurrent-claim test proves two insects can't take one card |
| 3 | **Workspace manager** (details below) | `packages/workspace` | Tests run against real temporary git repos |
| 4 | **Command guard + protected paths**: deny-list rules for shell commands and file paths; Claude Code pre-tool-use hook adapter | `packages/reflexes` | Table-driven tests of allowed and blocked actions |
| 5 | **Claude Code engine adapter**: detect, install (with consent), sign-in check; run a card headless with streamed output; model + effort flags; hooks wired to the guard; token usage captured | `packages/harness` | Smoke test against the real CLI (after user installs it) |
| 6 | **Hive runtime** (details below) | `packages/harness` | Scripted end-to-end run on a sample repo |
| 7 | **Brain service + doors**: Brain in its own utilityProcess (single writer); MCP server and `brain` CLI for insects | `packages/brain-mcp`, `packages/brain-cli` | Insect reads and writes the Brain through MCP in a test |
| 8 | **UI** (details below), wired over the typed IPC | `apps/desktop` | Playwright tests per screen |
| 9 | **Minimal onboarding**: Brain folder, Claude Code detect and sign-in, short "about you", Balanced preset | `apps/desktop` | First-run e2e test |
| 10 | **Phase 1 demo** on a small sample project | — | The goal above works end to end |

**Step 1, Brain core:**
- schema and migrations;
- single-writer API: write, update-as-new-version, archive (never delete), link;
- trust rules (01-D3);
- secrets guard (01-E6);
- exact-duplicate guard (01-E5);
- FTS5 keyword search;
- boot card and token-budgeted reads (01-D7).

**Step 3, Workspace manager:**
- git worktree + branch per card, dependencies linked;
- checkpoint before each card;
- single committer merging into `hive/<goal>`;
- undo card / goal;
- merge into main only after approval (06-D2, D3, D6).

**Step 6, Hive runtime:**
- **Queen:** plans a wave as JSON cards with the writing-plans skill; big-plan rule (02-D11) goes to approvals.
- **Foreman reflex:** dispatch loop within the insect cap.
- **Insects:** Coder and Tester run cards with the executing-a-task-card skill.
- **Inspector:** verification-before-completion.
- **Watchdog reflex:** timeouts, loops, breaker stop.
- **Treasurer reflex:** budget cap from token usage.

**Step 8, UI:**
- Queen chat with plan approval (Kokonut `ai-prompt`, `ai-tool-approval`);
- approval inbox;
- taskboard (Cult `kanban-board`);
- hive lanes with live output;
- changes & undo (Kokonut `ai-diff-review`).

## Progress

- **Step 1 Brain core: done (2026-11-12).** `packages/brain`, 34 tests:
  - trust levels;
  - agents can't confirm or overwrite what you confirmed;
  - secrets refused;
  - duplicates folded;
  - versions kept;
  - archive only;
  - links between real records only;
  - shelf-scoped keyword search;
  - token-budgeted reads;
  - 300-token boot card.

  Runs on `node:sqlite`; verified that FTS5 works inside Electron. The Brain-in-its-own-process part is Step 7.

## Not in Phase 1 (by design)
Other engines and providers, secret broker, embeddings and meaning search, code map, Brain graph, library activation, Cadence, containers. See Phase 2+.
