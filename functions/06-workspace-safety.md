# 06 — Workspace & Safety

**Status:** Finalized (2026-11-12)
**Created:** 2026-11-12
**Last updated:** 2026-11-12

---

## Purpose

Let many insects work at the same time **without overwriting each other, breaking the user's project, touching things they shouldn't, or doing anything that can't be undone.** This is the riskiest part of the AIOS: parallel agents with real file, terminal and network access.

## What can go wrong (the risks this function handles)

| Risk | Example |
|---|---|
| Collisions | Two insects edit the same file; one overwrites the other |
| Broken project | An insect's half-finished change lands on the user's main branch |
| Damage outside the task | `delete` on the wrong folder, a force-push, dropping a database |
| Leaks | An insect reads `.env`, SSH keys, or sends private data to a website |
| No way back | A wave of changes turns out wrong and can't be reverted cleanly |
| Git corruption | Many processes running git at once corrupt `.git/index.lock` |

## Reference: Munder Difflin (read from its source, MIT)

- **Single committer:** only the app's main process runs git commits. Agents never call git; they write plain files. This avoids `index.lock` corruption, with retry, backoff and stale-lock cleanup.
- **Single writer per file:** each agent writes only inside its own folder. Messages between agents are moved by a router, so no file is ever written by two processes.
- **Isolated worktrees** for workers, with the base checkout's dependencies linked in so each worktree doesn't reinstall them.
- **Sandboxed file/git access:** every file and git call is path-checked and limited to the agent's working folder.
- **Hooks go in a git-ignored local settings file**, so the user's repo isn't modified.
- **Auto mode** (agents skip per-command permission prompts) is one switch for the whole office. Approvals for destructive actions, spending and scope changes go to the orchestrator.

## Design (agreed 2026-11-12 via D2–D8)

1. **One workspace per task card.**
   - For code in git: a **git worktree** on its own branch, with dependencies linked rather than reinstalled.
   - For non-git or non-code work (documents, data): a private **folder copy**.
   - The insect can only write inside its workspace.
2. **Single committer and merger.** Insects may commit inside their own branch. Merging into shared branches is done only by the harness, after the Inspector passes the card. If a merge conflicts, a new card goes to a Coder.
3. **Integration branch.** Finished cards merge into a hive branch (e.g. `hive/<goal>`), not the user's main branch. The user's main branch changes only with approval.
4. **Checkpoints and undo.** A checkpoint is taken before every card. Undo works at three levels: one card, one wave, or one whole goal. For git this uses branches and commits; for non-git folders, file snapshots. The Brain already keeps versions of its own records (01-D14).
5. **Command guard (a Watchdog reflex, plain code, model-independent).** A deny list is checked before any terminal or file action runs:
   - deleting outside the workspace;
   - formatting disks;
   - force-push or rewriting shared history;
   - dropping or truncating databases outside a local test copy;
   - changing system settings;
   - `curl | bash`-style installs.

   Blocked actions become an approval request or are refused. This uses the engines' own pre-action hooks where they exist, and the status bridges (04-D2).
6. **Protected paths.** Insects can't read or write `.env` files, keys, SSH and cloud credential folders, browser profiles, or any path the user marks "no-go". Secrets come only through the vault and broker (04-D4).
7. **Network rules per caste.** Default network access depends on the caste. All external *writes* go through Connections and approvals (02-D7, 04-D4).
8. **Sandbox levels.**
   - *Workspace* (the default): file and command rules above.
   - *Container:* optional, for running untrusted code or risky tasks.
9. **Clean-up.** Worktrees and folder copies are removed after a card is merged or abandoned. Checkpoints are kept for a retention period, then archived (never silently deleted, 01-D3).

## Inputs / Outputs

- **Inputs:** task cards (02), agent permissions (03), user's protected-path list, approvals.
- **Outputs:** isolated workspaces, merged results on the hive branch, checkpoints, blocked-action and approval records in the Brain.

## Dependencies on other functions

- **01 Memory:** single writer for the Brain (D14); versions and archive-not-delete; protected-path list and checkpoints recorded in the Brain.
- **02 Hive:** approvals (D7); Inspector before merge; Watchdog breaker (D9 P3) hosts the command guard; taskboard leases (D10).
- **03 Capabilities:** per-caste tools and permissions; git-workflow, reversible-migration and safe-refactor skills.
- **04 Connections:** vault and secret broker (D4); MCP filesystem/git scoped to the workspace (D5); status bridges (D2).
- **05 Cadence:** unattended runs use the same isolation; nothing risky happens unattended (D6).

## Open questions

- [x] Q1 — Isolation → D2.
- [x] Q2 — Merging → D3.
- [x] Q3 — Sandbox level → D4.
- [x] Q4 — Auto mode → D5.
- [x] Q5 — Undo → D6.
- [x] Q6 — Network → D7.
- [x] Q7 — Protected paths → D8.

*All questions closed as of 2026-11-12 (user accepted Claude's suggestions for all). The draft design above is now the agreed baseline.*

## Decisions made

- **D1 (2026-11-12) — Workspace & safety is function 06.**
- **D2 (2026-11-12) — One workspace per task card.** Code in git: its own git worktree and branch, with dependencies linked from the base checkout. Non-git or non-code work: a private folder copy. Insects write only inside their workspace.
- **D3 (2026-11-12) — Merging.** Only the harness merges, never an insect, and only after the Inspector passes the card. Finished cards merge into a per-goal hive branch (e.g. `hive/<goal>`). The user's main branch changes only with user approval, once per goal (not per card). Merge conflicts become a new card for a Coder. Insects may commit inside their own branch; the harness is the single committer for shared branches.
- **D4 (2026-11-12) — Sandbox levels.** Default: *workspace* rules (file limits + command guard). *Container* isolation is used for running untrusted code or risky tasks, chosen by the Queen/Watchdog or the user.
- **D5 (2026-11-12) — Auto mode inside the workspace.** Insects may run commands in their own workspace without asking each time, because work is isolated and undoable. The **command guard** (plain-code Watchdog reflex, independent of the AI model) always blocks: deleting outside the workspace, formatting disks, force-push or rewriting shared history, dropping/truncating databases outside a local test copy, changing system settings, and `curl | bash`-style installs. Blocked actions become an approval request or are refused. Hive approvals (02-D7) still apply.
- **D6 (2026-11-12) — Undo at three levels:** one card, one wave, or one whole goal. A checkpoint is taken before every card (git commits/branches, or file snapshots for non-git work). Checkpoints are kept 30 days after a goal closes, then archived, never silently deleted.
- **D7 (2026-11-12) — Network by caste.** Coder and Tester: package registries and documentation only. Researcher, Writer and Analyst: web reading through their tools (web.search, web.fetch, browser). Every caste: anything that sends or changes things outside goes through Connections (04-D4) and approvals (02-D7).
- **D8 (2026-11-12) — Protected paths.** Insects can never read or write `.env` files, private keys, SSH and cloud credential folders, browser profiles, or any path the user marks "no-go". Secrets reach agents only through the vault and broker (04-D4).

## Change log

- 2026-11-12 — Created with Munder Difflin reference, risk list, draft design and questions.
- 2026-11-12 — User accepted all suggestions → D2–D8.
- 2026-11-12 — **Finalized by user.** Further changes go through a new change-log entry.
