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
| 7 | **Brain service + doors**: Brain in its own utilityProcess (single writer); MCP server and `brain` CLI for insects | `packages/brain-service`, `packages/brain-mcp`, `packages/brain-cli` | Insect reads and writes the Brain through MCP in a test |
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
- **Step 7 Brain service + doors: done (2026-11-12).** Built in parallel by three workers on top of a shared service core. 101 new tests.
  - **`packages/brain-service` (17 tests):** the single-writer service.
    - **Transport:** newline-delimited JSON over a local named pipe (Windows) or a Unix socket in a private 0700 folder.
    - **Identity comes from the token, never from the request:**
      - The app holds the master token (the user).
      - Each insect run gets an agent token bound to its id, its project shelf, and read or read-write. Tokens are revocable, and revoking also closes open connections.
    - **Agent rules:**
      - Agents see only their shelf plus `global`; other projects' records look missing.
      - They change only records on their own shelf.
      - Read-only tokens can't change anything.
      - Brain rules still apply: trust, secrets and confirmed-by-user.
    - **Limits:** 1 MB frame limit and a 5 s hello timeout.
    - **Load test:** 8 clients × 25 concurrent writes all land exactly once.
  - **`packages/brain-mcp` (19 tests):** the official MCP SDK 1.32.2 over stdio.
    - **Tools:** 10 tools; read-only tokens only see the 6 read tools.
    - **Replies:** compact text to save tokens; errors come with hints.
    - **Startup:** without the env vars it still starts and explains the problem instead of hanging.
    - **Bundle:** 771 KB (no sqlite, no HTTP stack).
    - **Proof:** a stdio test spawns the real bundle and an insect writes and reads the Brain as itself.
  - **`packages/brain-cli` (42 tests):** `brain whoami | boot | search | read | get | history | links | write | update | archive | link`.
    - **Options:** `--json` output, and `--body -` reads the body from stdin.
    - **Exit codes:** 0 ok, 1 service error, 2 usage error.
    - **Launchers:** `writeBrainShims` writes `brain` (sh) and `brain.cmd`.
      - Two obvious Windows designs were injectable through cmd metacharacters.
      - The final `.cmd` captures arguments inside a never-run `rem` line and lets Node split them.
      - Tested for real in `cmd.exe` and Git Bash, from a path with a space.
    - **Guard fix:** a `brain` title mentioning `~/.ssh` was falsely blocked. Path checks are now skipped for the bare `brain` command only; redirects are still checked. 13 table tests added.
  - **Desktop:** the Brain host runs as an Electron `utilityProcess`.
    - **Startup:** main makes the endpoint and master token; the token travels only over parentPort, never in argv or env.
    - **Recovery:** ready/failed handshake, a 20 s start timeout, and crash restarts with backoff (1→30 s).
    - **Shutdown:** clean stop on quit.
    - **UI:** a `brainStatus` IPC call and a status line in the side panel.
    - **CLI launchers:** written to `<userData>/bin` on every start.
    - **Hive host:** decision recorded in code. Step 8 moves the Hive into this process, so `brain.db` keeps exactly one writer; main never opens it.
    - **e2e:** the Brain reaches ready; `brain.db` and the launchers exist.
  - **Harness:** per-run Brain access for insects (`brainAccess`).
    - **Per run:** the hive mints a token on the goal's shelf and passes `INSECTOIDS_BRAIN_*`. It writes a per-run `.mcp.json` (0600, used with `--strict-mcp-config`, deleted afterwards), puts the launcher folder first on PATH, and adds a "The Brain" section to the brief.
    - **Revocation:** the token is revoked in `finally`.
    - **Access by caste:** Coder/Tester read-write (their writes still start unconfirmed/proposed). Queen read-only (the hive records her plan). Inspector read-only (a verifier must not shape the memory it checks against).
  - **Root:** `pnpm build:doors` builds the guard hook and both door bundles; `dev` and `test:e2e` run it first.
  - **Open:**
    - Packaged-app door paths (`resources/doors`) are a Phase 3 TODO.
    - A host crash/restart isn't covered by e2e.
    - Not yet run through the real Claude CLI; that comes with the Step 10 demo or the opt-in smoke test.
- **Step 8 UI: done (2026-11-12).** Built by four parallel workers on a shared contract (`packages/shared/src/hive-api.ts`) and one renderer store (`lib/hive-store.ts`). 403 unit tests and 25 e2e tests pass.
  - **The Hive moved into the brain-host utilityProcess** (`HiveManager`), so `brain.db` has exactly one writer.
    - **Project:** the folder picker; saved in `settings.json`.
    - **Hive runtime:** one `Workspace` + `Hive`, with a Foreman tick that never overlaps.
    - **Read model:** activity log (300 lines) and agent lanes (model and effort as reported by the engine, tokens, cost, last 200 output lines).
    - **IPC:** typed RPC between main and the host over parentPort (30 s timeout). Pushes (`changed`, `agent-output`) are batched every 100 ms and forwarded to the window. Every IPC payload is checked with zod on both sides.
    - **Engine:** Claude Code reports missing / outdated / signed-out / ready with the fix in plain words, and re-checks every 60 s. `INSECTOIDS_ENGINE=fake` runs a scripted demo (`harness/src/hive/demo.ts`) for e2e tests and token-free demos.
    - **Hive additions:** cancel goal, undo card/goal, undo merge and redo merge (each with approval; `Workspace.redoMainMerge` reverts the undo commit), and run lifecycle events.
    - **Approvals:** acting on an approval happens before the decision is recorded, so a failed merge stays waiting; deciding twice is refused.
    - **Tray:** shows working / idle / paused and how many approvals are waiting, with Pause and Resume.
  - **Screens** (each source library noted in its component's top comment):
    - **Queen chat** (Kokonut `ai-prompt` composer, `ai-tool-approval` plan card with inline Approve/Deny, `empty-state` project picker, `inline-alert` for errors and the engine-not-ready state);
    - **Approval inbox** (filter chips, keyboard list; Kokonut `hold-button` hold-to-approve for destructive items);
    - **Taskboard** (Cult `kanban-board`, read-only, goal and wave switchers, card detail);
    - **Hive monitor** (Kokonut `ai-agent-lanes` timeline, lanes table, live read-only output, throttled screen-reader updates);
    - **Changes & undo** (Kokonut `ai-diff-review`, `undo-button`, and the merge panel: not merged → waiting → merged → undo → merge again);
    - **Brain reader** (search, kind filters, trust badges, versions, links; the graph is Phase 2);
    - also the live side panel, a top-bar status pill, and an approvals badge on the rail.
  - **Found and fixed during integration:**
    - **Guard hook environment:** the hook ran with `ELECTRON_RUN_AS_NODE` in Claude's environment, so every insect shell command inherited it. Any project that starts Electron (this one included) would have broken. Now a per-hook launcher (`main/hook-launcher.ts`, `<userData>/hooks/guard-hook.cmd`) sets it for the hook alone; the MCP door and `brain` CLI already set it themselves. Tested through `cmd.exe` from a path containing a space and a `%`.
    - **Brain search:** punctuation was deleted, so "hello.txt" became "hellotxt" and pasted sentences found nothing. Punctuation now splits words the way the FTS index does; a regression test was added.
  - **Still to verify:**
    - Real Claude Code through the new hook launcher (Step 10 demo). If the launcher fails, the hook's `onFailure: block` stops every tool, which is safe.
    - Door and library paths for the packaged app (Phase 3).
  - **Screenshots:** `design/screenshots/phase-1-step8-*.png`.
- **Step 9 Minimal onboarding: done (2026-11-12).** Two parallel workers built it on the shared contract `packages/shared/src/setup-api.ts`. 417 unit tests and 36 e2e tests pass.
  - **First-run wizard** (Cult UI `onboarding` step frame, shadcn `button`, Kokonut `inline-alert`): Welcome with the privacy promise → Brain folder → AI engine → About you → Safety → First project → Done.
    - Every step except Welcome can be skipped, and Enter moves to the next step, so the whole wizard works by keyboard.
    - The engine step shows Claude Code's state with "Check again", plus the exact install, sign-in or update command to copy. It never runs them itself (04-D6).
    - "About you" is a chat-style interview (08-D3/D4). Answers become confirmed facts on the Global shelf; answering again updates the same record; secrets are refused inline.
  - **Safety presets (08-D7):**
    - **Careful:** 2 insects, 1M-token goal budget, every plan needs approval.
    - **Balanced (default):** 3 insects, 2M, big plans only.
    - **Hands-off:** 5 insects, 4M, big plans only.
    - The "always asks you" list and the command guard can't be switched off. Presets apply live to the hive (new `approveEveryPlan` option in the harness Hive).
  - **Settings screen:** the "finish setup" checklist (phase-2 items marked "later"), "Run setup again", the preset switcher, and the Brain folder (Change… / Back to default).
  - **Main** owns `<userData>/app.json` (atomic writes). The Brain folder switch:
    - checks the folder first (full path, a folder, writable);
    - is refused while goals are planning or running;
    - restarts the Brain host on `<dir>/brain.db`, reusing an existing Brain as is, and rolls back to the old Brain if the new one fails.
    - The `bin/` and `hooks/` launchers always stay in the profile folder.
  - **Gate:** if setup state can't be read, the gate offers Retry and "Open the app without setup", so the app never locks the user out.
  - **e2e:**
    - `launchApp({ onboarded })` skips setup by default; `first-run.spec.ts` walks the whole wizard by keyboard and mouse.
    - `setup-backend.spec.ts` covers presets → insect cap, answers in the Brain, the secret refusal, the real Brain folder switch (`INSECTOIDS_E2E_PICK_FOLDER` replaces the dialog in tests only) and finish.
  - **Found in screenshots:** on the Balanced card, the "Recommended" badge pushed "Selected" outside the card. Fixed by wrapping the card header.
  - **Screenshots:** `design/screenshots/phase-1-step9-*.png`.
- **Step 10 Phase 1 demo: done (2026-11-12). The Phase 1 goal works end to end with real Claude Code.**
  - **Runner:** `apps/desktop/e2e/phase1-demo.spec.ts`, opt-in.
    - `INSECTOIDS_DEMO=real` uses Claude Code; `=fake` is a token-free dry run of the same flow. It never runs in the normal suite.
    - Sample project: `tiny-text`, a dependency-free Node library with one function and passing tests (`e2e/support/sample-project.ts`).
    - Output goes to `demo-runs/<time>/` (gitignored): sample project, screenshots, `summary.json`, activity log, every agent's output.
  - **Real run (11:31 UTC):** PASSED in 1.8 min, 83k tokens, **$0.53** (estimate was $1.5–4).
    - **Plan:** the goal ("add `slugify(text)` … tests … README") was typed into the real Queen composer. The Queen (claude-opus-5-5, high) planned 1 wave with 2 cards (coder + tester), giving both cards one exact definition of the function, in 30 s. Under the Careful preset the plan waited for approval.
    - **Work:** the coder (Ant-01) and tester (Ant-02) ran on claude-sonnet-5-5 in their own worktrees, 20 s each. The Inspector verified each card against every "done means" item, with evidence from `node --test`, the diff and `git status`. 0 retries.
    - **No user approvals were needed for blocked actions,** and no guard denials appear in any output.
    - **Merge, undo, merge again:** merge approved → `node --test` 10/10 on `main`. Undo approved → `main` matched the start exactly. Merge again approved → 10/10 again. Files: `src/index.js`, `README.md`, `test/slugify.test.js`.
    - **Brain:** the goal task, both "verified" outcomes, and the merged / undone / re-applied outcomes.
    - **Guard hook launcher:** works with the real CLI.
    - **Screenshots:** `design/screenshots/phase-1-demo-*.png`.
  - **Findings to fix:**
    1. **Insects commit by themselves. FIXED (2026-11-12).** The coder ran `git commit` in its worktree, with Claude's own `Co-Authored-By` line. The hive still merged correctly, but these commits skipped the single committer's hive identity and the `Insect:` / `Card:` trailers.
       - **Guard:** now blocks (`hive-commits`) every git command that creates commits or moves branches in a card workspace: `commit` (incl. `--amend`), `merge`, `rebase`, `cherry-pick`, `revert`, `am`, `pull`, `commit-tree`, `update-ref`, `switch`, `checkout -b/-B/--orphan`. It also catches them after global options and inside nested shells. The message tells the insect to leave changes uncommitted.
       - **Hive rules:** now say "don't commit, merge or switch branches; the hive commits them for you".
       - **Tests:** 15 new table tests. Read-only git (`status`, `diff`, `log`, `stash`, `checkout -- file`) stays allowed.
       - **Confirmed with real Claude (run 2, 11:49 UTC):**
         - PASSED in 1.6 min, 82k tokens, $0.51, 2 cards, 0 retries; tests passed on `main` after the merge and after the redo.
         - Both card commits are authored by "The Insectoids" with `Insect:` / `Card:` trailers.
         - No insect tried to commit, so the hive rule alone was enough; the guard stays as the backstop.
         - The merge / undo / redo commits on `main` carry the project's own git identity, since the user approved them.
    2. **Effort:** every insect and Inspector run shows effort `high`. The router asks for `medium` on normal-priority cards, so check whether the Queen marked the cards high or the engine reports a different effort than was requested.
    3. **Plan card wording:** the Queen's plan summary is long for a chat card, and its text claimed "auto-approved" under the Careful preset. Ask for a short summary line, and keep approval wording out of the Queen's text (the hive decides it).
- **Brain research note: ruvector (2026-11-12, for Phase 2).** We reviewed github.com/ruvnet/ruvector against our Brain spec.
  - **Verdict:** don't take it as a dependency.
  - **Why not:**
    - Only its vector store (`ruvector-core`, built on `hnsw_rs` + `redb`) is real.
    - It had correctness bugs fixed only in Sep and Nov 2026.
    - Its README admits that compaction and consolidation aren't wired in, and that every start rebuilds the index.
    - A second storage file would break one-transaction single-writer saves.
    - It ships native binaries (no Windows arm64).
    - It has near-daily npm releases from a single maintainer.
  - **Ideas to borrow:**
    - an importance score for decay (recency + frequency + coherence; E7);
    - trust weight = confidence × reliability × freshness half-life (D3, E9);
    - Reciprocal Rank Fusion (k = 60) to merge FTS5 keyword and meaning results.
  - **Phase 2 meaning-search plan:**
    - store embeddings in the same Brain file (BLOBs + brute force, or `sqlite-vec`, still pre-1.0);
    - benchmark on real Brain data;
    - consider an approximate index only past about 100k records (R7).
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
