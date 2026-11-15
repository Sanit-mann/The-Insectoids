# 10 — Build Roadmap

**Status:** Finalized (2026-11-12) · Phase 0 in progress
**Created:** 2026-11-12
**Last updated:** 2026-11-12

---

## Purpose

Turn functions 01–09 into an order of work: the smallest version that proves the whole idea end to end first, then widen it phase by phase. Each phase ends with a demo the user checks before the next one starts.

## Guiding rules (proposed)

1. **One thin slice through everything first.** A goal goes in, the Queen plans, insects work in isolated workspaces, the Inspector verifies, the user approves the merge, and undo works. Everything is recorded in the Brain. Breadth comes later.
2. **Safety ships with the first slice, not after.** Worktrees, the command guard, protected paths, approvals and undo are in Phase 1, because the hive touches real files from day one.
3. **Plain code before AI.** Reflexes, leases, budgets and the code map are deterministic code first (3Ms "Lego principle").
4. **Every phase ends in a demo and a written outcome** in the Brain (once it exists) and in this file.
5. **Test-driven** for core services (Brain, taskboard, workspace, guard, broker).

## Proposed phases

### Phase 0 — Foundation
- Monorepo (pnpm), TypeScript config, lint, Vitest, Playwright, CI on Windows/macOS/Linux with native-module rebuilds.
- Electron shell: main, preload (typed IPC bridge), React renderer, tray, design tokens, and the first registry components installed.
- `packages/shared`: core types (records, task cards, agents, approvals).
- **Demo:** the app opens with the rail and an empty Queen screen; tests run in CI.
- **Outcome (2026-11-12, branch `phase-0-foundation`), built and verified locally on Windows:**
  - **Toolchain:** pnpm 12.18 workspace with the `apps/desktop` and `packages/shared` packages; TypeScript 6.0.3 (typescript-eslint doesn't support 7 yet); ESLint 10; Vitest 5; Playwright 1.65.
  - **Electron 45.2.3:** the newest release that passes pnpm's minimum-release-age supply-chain check.
  - **`@insectoids/shared`:** castes, ranks, statuses, task card schema and lifecycle rules (Hive D10), approvals, Brain record kinds and trust levels, and the typed IPC contract.
  - **Desktop app:**
    - sandboxed window with context isolation and no Node in the UI;
    - only the app's own pages may call IPC;
    - https links open in the system browser and all other navigation is blocked;
    - strict CSP on built pages and all browser permissions denied;
    - single instance; close-to-tray.
  - **UI:**
    - rail with all 10 screens, Queen empty state, side panel, version from the main process;
    - dark and light themes from the design tokens;
    - bundled fonts, so no network calls.
  - **Tests:** 35 unit tests and 5 end-to-end tests pass; lint and typecheck clean. CI workflow for Windows, macOS and Linux written (not yet run: no remote repository).
  - **Not done in Phase 0:** no registry component installed yet; the first one (the Queen composer) moves to Phase 1. `pnpm dev` (hot-reload mode) not exercised; the built app was.
  - **Screenshots:** `design/screenshots/phase-0-queen-dark.png`, `phase-0-queen-light.png`.

### Phase 1 — "First Spark" (the MVP)
- **Brain core:**
  - schema (files, decisions, tasks, facts, outcomes, agent memory, links, versions);
  - the single-writer service;
  - FTS5 keyword search;
  - boot card + tiered reads;
  - MCP and CLI doors;
  - secrets guard.
- **Hive core:**
  - Queen;
  - Coder and Tester castes;
  - Inspector (LLM);
  - Foreman, Watchdog and Treasurer as **reflexes only** (leases, budget cap, loop stop);
  - taskboard with atomic claims, leases, and retry then escalate.
- **One engine: Claude Code**, with its status bridge and pre-action hooks for the command guard.
- **Workspace & safety:**
  - git worktree per card;
  - single committer and hive branch;
  - checkpoint and undo per card and per goal;
  - command guard;
  - protected paths;
  - approvals.
- ~~**Vault** for any keys (safeStorage).~~ Moved to Phase 2 (2026-11-12): nothing in Phase 1 stores keys (Claude Code keeps its own login), so the Vault ships with its first user, API providers.
- **Library:** core agents and skills loaded for the Queen, Coder, Tester and Inspector.
- **UI:**
  - Queen chat with plan approval;
  - approval inbox;
  - taskboard;
  - hive monitor (lanes only);
  - changes & undo.
- **Onboarding (minimal):**
  - Brain folder;
  - Claude Code detection and sign-in;
  - a short "about you";
  - the Balanced preset.
- **Demo:** "Add a contact form with tests to this small project."
  1. The Queen plans and you approve.
  2. Coder and Tester insects work in parallel worktrees.
  3. The Inspector verifies.
  4. You approve the merge.
  5. You undo it and redo it.
  6. The Brain shows the decisions, tasks and outcomes.

### Phase 2 — The Full Hive
- **Vault** (safeStorage) for API keys, arriving with API providers (moved from Phase 1).
- **All castes and managers:**
  - all 8 castes and all 6 managers;
  - managers' LLM "brain" side and periodic reviews;
  - Scout;
  - Librarian maintenance.
- **Treasurer router:** model + effort per card, rule-based first, then learning from outcomes.
- **Watchdog:** breaker ladder.
- **Engines:** Codex, Gemini CLI, OpenCode with OpenAI-compatible providers (OpenRouter, FreeLLMAPI, Ollama, LM Studio); "model actually used" reporting; subscription usage tracking.
- **Secret broker** with per-card tokens; Phase-1 services (GitHub, web search/fetch).
- **Brain:**
  - local embeddings (meaning search);
  - code map (tree-sitter);
  - graph view;
  - reader with edit;
  - dedupe, ranking and decay;
  - lessons register;
  - health score.
- **Library:** dormant catalog search, activate/deactivate per task, skill proposals (03-D6).
- **UI:**
  - living-hive view;
  - Brain screens;
  - Library;
  - Connections;
  - Budgets.
- **Onboarding:** full flow, all three presets, sample goal.
- **Demo:** a multi-wave goal across 3+ castes and 2 engines, routed by cost, with a skill proposed from repeated work.

### Phase 3 — Cadence & Polish
- **Cadence:**
  - schedules, file watch and webhooks;
  - trust modes;
  - catch-up on wake;
  - maintenance jobs;
  - "while you were away" digest;
  - desktop notifications.
- **Tray and background:** background running polish, keep-awake switch.
- **Release:**
  - light theme;
  - accessibility pass (WCAG 2.2 AA);
  - Obsidian export;
  - update checks;
  - signed installers for Windows, macOS and Linux.
- **Demo:** a weekly scheduled report runs while the app sits in the tray; the morning digest shows it.

### Phase 4 — Expansion
- **Connections:**
  - Phase-2 services (Notion, Linear, Jira, Slack);
  - OAuth broker, then Gmail and Calendar;
  - more engines (Copilot, Cursor, then the rest).
- **Safety:** container sandbox mode.
- **Brain:** phase-2 views (globe, dashboard, timeline), ask-the-brain box.
- **Later:** voice input, phone companion, team shelves, batch rewriting of the dormant library.

### Phase 5 — Local First (proposed by the user, 2026-11-15)
- **First step: a free local model set up for the user** (08-D9). During setup the app offers to download Ollama, reads the PC's hardware, picks a local model that will run well on it from a list the app ships and tests, downloads it with the user's yes, checks that it works, and adds it as a provider. The Treasurer then gives it the light work it can do (questions, summaries, the Librarian's tidying, small cards) and keeps paid engines for the rest, so the user spends less money and fewer subscription limits.
- The rest of Phase 5 is planned when it starts.

## Dependencies on other functions

Sequences everything in 01–09.

## Open questions

- [x] Q1–Q5 — Delegated by the user to Claude ("you decide") → D2–D6.

*All questions closed as of 2026-11-12.*

## Decisions made

- **D1 (2026-11-12) — Build roadmap is function 10.**
- **D2 (2026-11-12) — MVP = Phase 1 "First Spark" as listed,** after Phase 0. The phases and guiding rules above are adopted.
- **D3 (2026-11-12) — Claude Code is the only engine in the MVP** (best pre-action hooks for the command guard). Codex, Gemini CLI and OpenCode follow in Phase 2.
- **D4 (2026-11-12) — Way of working:** Claude builds phase by phase. Each phase is split into small steps that each end in something working, test-first for core services (Brain, taskboard, workspace, guard, broker). Every phase ends with a demo the user checks and approves before the next starts; the user can check in any time.
- **D5 (2026-11-12) — Dogfooding:** once the MVP works, The Insectoids helps build its own later phases, with Claude supervising.
- **D7 (2026-11-15) — Phase 5 starts with local model setup** (the user's suggestion; details in 08-D9). It builds on the Treasurer's rule that light work goes to a free local model first (02-D9).
- **D6 (2026-11-12) — Version control:** git is set up in this folder now, local only, with a first commit of the specs, design and library. A private GitHub repository is created later, only when the user wants it. Nothing is pushed or published without the user.

## Change log

- 2026-11-12 — Created: guiding rules, four phases with demos, questions.
- 2026-11-12 — User delegated Q1–Q5 → D2–D6. Git repository initialised locally (`main`), with `.gitignore` (excludes Brain databases, vault, env files, worktrees) and `.gitattributes` (LF line endings).
- 2026-11-12 — First local commit `1fe0aa8`. **Finalized by user;** Phase 0 started on branch `phase-0-foundation`.
- 2026-11-12 — **Phase 1 "First Spark" complete** (branch `phase-1-first-spark`, see [docs/plans/phase-1-first-spark.md](../docs/plans/phase-1-first-spark.md)). The real end-to-end demo passed twice with Claude Code. The Vault moved from Phase 1 to Phase 2 with the user's agreement, because nothing in Phase 1 stores keys. Published to GitHub as v0.0.1.
- 2026-11-15 — Phase 5 "Local First" added, starting with the user's suggestion: a free local model set up for the user during first-run setup (D7, 08-D9).
