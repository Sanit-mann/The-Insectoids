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
- **Step 2 Taskboard store: done (2026-11-12).** `Taskboard` in `packages/brain`, sharing the Brain's database and single writer. 20 tests cover:
  - posting with validation;
  - caste-matched, atomic claim, with dependency locking in the same SQL statement;
  - `claimNext` by priority, then age;
  - leases with heartbeat and an expiry sweep; blocked cards pause their lease;
  - holder-only moves;
  - the Inspector's review as the only road to done;
  - retry, then escalate after `maxAttempts`;
  - a full event history.

  **Race test:** 8 threads with separate connections claim one card at the same instant, and exactly one wins (30/30 repeated runs). It exposed a real bug, now fixed: the Brain set WAL mode before its lock timeout, so opening while another connection was busy failed instead of waiting.

  Shared lifecycle change: `claimed -> failed` is allowed, for a card whose leases keep expiring until it runs out of attempts.
- **Step 3 Workspace manager: done (2026-11-12).** `packages/workspace`, 19 tests against real temporary git repos (project path contains a space):
  - **Isolation:** `hive/<goal>` branch plus an integration worktree per goal, kept outside the project folder; a worktree and `hive-card/<goal>/<card>` branch per card, started from the hive tip so it sees earlier merged cards.
  - **Dependencies:** linked into cards (directory junction on Windows), never committed. Links are unlinked before removal so the real `node_modules` is never deleted.
  - **Committing and merging:**
    - single committer with the hive identity plus `Insect:` / `Card:` trailers;
    - conflicts reported and the merge aborted, never forced;
    - merging into main needs `approvedBy`, the project on the target branch, and no uncommitted tracked changes;
    - main merges can be undone, also only with approval.
  - **Undo:** a card is reverted (history kept); a goal is reset to its checkpoint with the old tip kept under `refs/insectoids/archive/…`.
  - **Changes view:** a per-card diff (files + patch).
  - **Safety:** ids are validated (no `..`, no leading `-`); git runs with no shell and no prompts.

  Respects the user's git line-ending setting (`core.autocrlf`).
- **Step 4 Command guard: done (2026-11-12).** `packages/reflexes`, 116 tests, POSIX and Windows paths.
  - **Shell parser:** separators, pipes, quotes, redirections, `$(…)`, backticks, `<(…)`, `bash -c` / `cmd /c` / `powershell -Command` nesting. It fails safe: anything unparseable becomes "ask".
  - **Always blocked:**
    - deleting outside the workspace, the workspace root, or linked dependencies;
    - writing outside the workspace or into git internals;
    - force-push or deleting remote refs;
    - git on another repo (`-C`, `--git-dir`);
    - links pointing outside the workspace;
    - disk formatting, `dd` to devices, power and system changes (registry, services, execution policy, `setx`);
    - piping into shells or `iex`, `eval`, encoded PowerShell;
    - `sudo` and friends;
    - protected files (`.env*` except examples, keys, SSH/AWS/GnuPG/Azure/Kube/Docker credentials, `.npmrc`, browser profiles);
    - user no-go folders.
  - **Needs approval:** push, new or global dependencies, publish and deploy, destructive database commands, remote copies, scheduled tasks.
  - **Bypass tests:**
    - escaped and full-path command names, `env` and variable prefixes, `..` tricks;
    - command substitution and backticks;
    - profile edits;
    - symlinks, including a real directory junction on disk resolved with `fsRealpath`.

    They found and fixed 3 real gaps: git global options hiding the subcommand, link creation, and writing through links.
  - **Claude Code adapter:** maps Bash/PowerShell, Read/Write/Edit/MultiEdit/Notebook, Glob/Grep, WebFetch/WebSearch (caste network policy: none / docs-and-package sites / web, https only) and MCP tools. "Ask" becomes a deny telling the insect to block its card for approval. `runHook` fails closed on a bad input or missing policy.
  - **Honest limit:** this is one safety layer, not a sandbox. Untrusted code runs in container mode (06-D4); engines without hooks are restricted (09-D5).
- **Step 5 Claude Code adapter: done (2026-11-12).**
  - **Install:** Claude Code CLI 2.1.322 installed with the official native installer (with the user's approval) at `~/.local/bin/claude.exe`; Authenticode-signed by "Anthropic, PBC", valid. The user signed in with `claude auth login` (claude.ai account).
  - **Added:**
    - `MIN_CLAUDE_VERSION` 2.1.295 (older CLIs are reported "outdated" and never used);
    - `checkClaudeAuth` via `claude auth status` JSON, which costs no tokens. It exits non-zero even when signed in, so the JSON is read regardless of the exit code.
  - **Real-CLI smoke test** (`claude.smoke.test.ts`, only with `INSECTOIDS_SMOKE=1`) **passed**:
    - Haiku 5.5 (`claude-haiku-5-5`), 3 turns, $0.0049;
    - prompt on stdin works; stream-json fields match;
    - the hook from `--settings` fires in `-p` mode: Read of `.env` **denied** (`protected-path`), Write of `hello.txt` allowed;
    - the model respected the denial and did not try another route.
  - **Token finding for Phase 2 (Treasurer):** Claude Code's default system prompt is about 18k tokens (17,850 cache write; 107k cache reads over 3 turns). Cheap when cached, but a slim hive-specific system prompt (`--system-prompt-file`) could cut per-card overhead. Evaluate against quality.
- **Step 6 Hive runtime: done (2026-11-12).** `packages/harness/src/hive`.
  - **6a, Brain:** goals (planning → awaiting approval → running → stuck/done/cancelled, plan, current wave, token and dollar spend, budget) and the approval inbox (only the user decides; decisions are final).
  - **6b, protocol:**
    - the Queen replies with a JSON plan, checked for allowed castes, "done means" on every card, real and earlier dependencies, no cycles, at most 6 waves × 6 cards, with one correction round;
    - insects end with a `STATUS:` line; the Inspector ends with a `VERDICT:` line (no verdict counts as a fail).
    - Prompts are built from the library: role AGENT.md plus default skills plus hive rules. Measured sizes: Queen ~3.9k, Coder ~4.4k, Tester ~4.9k, Inspector ~3.0k tokens.
  - **6c, Treasurer router (rule-based):** Queen on the strongest model/high effort; cards by priority; each retry raises effort, then the model tier. Every run gets turn, dollar and time limits. Budget counts input + output + cache-write tokens; warn at 75%, stop at 100%.
  - **6d, `Hive` orchestrator** behind an `Engine` interface (`ClaudeEngine` for real runs, `FakeEngine` for tests):
    - the Queen plans (read-only, scratch workspace); a big plan (more than one wave, D11) waits for approval;
    - waves are posted one by one;
    - the Foreman dispatches by caste within the insect cap; each insect gets its own worktree, guard policy, heartbeat lease and route;
    - `STATUS: BLOCKED` plus guard "ask" denials become an approval. Approving resumes the card with exactly that rule allowed (`approvedRules`; never affects "block");
    - the Inspector verifies on the committed branch; pass merges into the hive branch; fail retries with the reason, then escalates; merge conflicts count as a fail;
    - a goal with a failed card is "stuck";
    - after the last wave, the merge into main waits for approval;
    - the budget stop asks to raise the budget by 50%; an engine sign-out pauses the hive;
    - outcomes are written to the Brain.
  - **11 end-to-end tests on real git repos with `FakeEngine`.** They found a real bug: parallel inspections merged at the same time in one worktree and collided. Fixed by making `Workspace` a true single committer: every git operation is queued, with a parallel-merge test added. The suite test timeout was raised to 30 s for git-heavy tests on Windows.
  - **Not yet run with the real engine:** a real multi-agent run costs subscription tokens and is planned for the Step 10 demo, or earlier on request.
- **Step 5 history (built before the CLI was installed):** `packages/harness`, 10 tests against a fake CLI that speaks the same protocol and runs the real bundled guard hook.
  - **Command line, from the official CLI reference:**
    - `-p --output-format stream-json --verbose`;
    - `--permission-mode dontAsk` (tools run only when the guard allows);
    - `--setting-sources project,local` (the user's personal hooks and plugins don't leak into insects);
    - `--no-session-persistence`;
    - the guard via inline `--settings`;
    - `--model`, `--effort` (low…max), `--max-turns`, `--max-budget-usd`;
    - brief via `--append-system-prompt-file`; MCP via `--mcp-config --strict-mcp-config`;
    - the prompt on stdin.
  - **Hook safety:** Claude Code lets a tool run when a hook fails with a non-2 exit code. So the hook is registered with `onFailure: "block"` (v2.1.295+), and the hook process itself exits 2 on any internal failure. The hook is bundled to one file (`packages/reflexes`, `build:hook`, 26 KB) with rolldown.
  - **Stream events:** init (session, model), text, tool use and result, final result (cost, tokens incl. cache, turns, models actually used). Malformed lines are ignored.
  - **Run results:** ok, auth (signed out), timeout, stopped (Watchdog), limit (turns or budget), model error, crash. Process trees are killed on stop (`taskkill /T` on Windows, process group on POSIX).
  - **Detection:** native `claude.exe` (`~/.local/bin`) or on PATH, parsed with `--version`. An npm `.cmd` shim is reported unsupported (no shell spawning).
  - **Open:** the real CLI isn't installed yet. The smoke test against it still needs to confirm stdin prompts in `-p` mode, the stream-json field names, and that hooks from `--settings` fire in `-p` mode.

## Not in Phase 1 (by design)
Other engines and providers, secret broker, embeddings and meaning search, code map, Brain graph, library activation, Cadence, containers. See Phase 2+.
