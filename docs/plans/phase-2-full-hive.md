# Phase 2 "The Full Hive": Implementation Plan

**Branch:** `phase-2-full-hive` · **Started:** 2026-11-12 · **Spec:** [functions/10-build-roadmap.md](../../functions/10-build-roadmap.md) (Phase 2)

**Goal:** the whole hive works across two engines, and it learns. In the Phase 2 demo:
1. A multi-wave goal runs across 3+ castes and 2 engines (Claude Code and Gemini CLI).
2. Each card is routed by cost and by what has worked before.
3. The Brain finds things by meaning, not just keywords, and keeps itself tidy.
4. The hive proposes a new skill from repeated work.

Like Phase 1, every step ends in something that works and is tested, and core services are built test-first.

## Starting point (decided 2026-11-12)

- **Engines the user has:** paid **Claude** and paid **Gemini** plans.
  - The demo uses **Claude Code + Gemini CLI**.
  - **Codex** has no plan to test against yet. The engine interface stays generic so a Codex adapter is a small step later.
  - **OpenCode** and API providers are built and tested against a local fake provider; a real run waits until the user adds a provider (OpenRouter, FreeLLMAPI, Ollama or LM Studio).
- **Local embeddings:** the user approved a one-time model download (about 90 MB at most). It comes from Hugging Face, is pinned by checksum and stored in the app's data folder. Only the model is downloaded; no Brain data ever leaves the PC.
- **Managers' order** (chosen by Claude, as the user asked):
  1. **Treasurer:** routing across two engines and usage limits, needed for the demo.
  2. **Watchdog:** breaker ladder; safety first.
  3. **Scout:** better plans for the Queen.
  4. **Librarian:** keeps the Brain healthy; pairs with Milestone B.
  5. **Foreman** brain side.
  6. **Inspector** improvements.

  Phase 1 already has the Foreman, Treasurer and Watchdog as reflexes and the Inspector as an LLM. Phase 2 adds their "brain" side (02-D8): an LLM that wakes only for events that need judgment, or for a periodic review.
- **Phase 1 approval (D4):** the user moved on to Phase 2 after the Phase 1 demo was published.

## Steps

Three milestones, each ending in something the user can try.

### Milestone A: Engines, keys and routing

| # | Step | Package | Done when |
|---|---|---|---|
| A0 | **Phase 1 leftovers** (details below) | `harness`, `desktop` | Tests for each; real effort verified in a smoke run |
| A1 | **Engine registry:** the `Engine` interface becomes a registry of adapters with capabilities (hooks? MCP? effort levels? cost reported?). The hive picks per card. Connections screen (engines: status, version, sign-in state, install with consent 04-D6) | `harness`, `shared`, `desktop` | Claude engine runs unchanged through the registry; Connections e2e |
| A2 | **Gemini CLI adapter**, safe by design (details below) | `harness`, `hive-tools-mcp` (new) | Opt-in smoke test against the real CLI: a write through the hive's tools is guarded, a direct shell/write is denied by policy |
| A3 | **Vault + secret broker** (04-D4): keys encrypted with the OS (Electron `safeStorage`), fail closed, handles only. A local broker gives each card a capability token scoped to its card and integrations, which expires when the card ends. First services: GitHub and web fetch/search through the broker | `vault` (new), `broker` (new), `desktop` | Agents never see a key (tests); revoked tokens refused; Vault UI |
| A4 | **API providers + OpenCode adapter** (04-D3): one "OpenAI-compatible provider" form with presets (OpenRouter, FreeLLMAPI, Ollama, LM Studio); OpenCode as their doorway | `harness`, `desktop` | Tests against a local fake OpenAI-compatible server |
| A5 | **Treasurer v2** (02-D9 P1, 04-D7): usage and limit windows per subscription; routing across engines by caste, size, priority and cost; learning from outcomes (success, retries, time, cost per caste × model × effort, recorded in the Brain); falls back when a subscription is exhausted | `harness`, `brain` | Router tests with recorded outcomes; usage shown in the UI |

**A0, Phase 1 leftovers:**
- **Effort:** find out why every run reported `high` (the Queen's priorities, or the engine reporting something other than what was requested), and show requested vs actual.
- **Plan card:** a one-line `headline` field in the Queen's plan JSON; the long summary goes behind "Details", and the Queen never writes approval wording.
- **Crash test:** an e2e test that kills the Brain host and proves it restarts and the app recovers.

**A2, Gemini CLI adapter** (design follows the research below):
- **Safety without hooks.** Gemini CLI's pre-tool hook fails open, so the guard can't rely on it. Instead:
  - A new **hive tools MCP server** (`packages/hive-tools-mcp`) offers shell, write, edit and delete, and runs the command guard inside itself before acting, so it fails closed. The same guard and the same rules as Claude runs.
  - A per-run **admin policy** (TOML) denies every built-in Gemini tool except read-only ones (read, list, search) and allows only the hive's MCP servers. It is a static rule, so it can't fail open.
  - The BeforeTool hook stays as a second layer only, wrapped so any internal error exits 2.
- **Isolated run config:**
  - a per-run system settings file (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`);
  - `-e none` (no extensions) and `--allowed-mcp-server-names` (only the hive's servers);
  - `--skip-trust`;
  - a unique context file name, so the user's `GEMINI.md` stays out;
  - usage statistics off, and `billing.overageStrategy: "never"` so AI credits are never spent.
- **Run:** headless `-p` with `-o stream-json`. Spawned as `node …/bundle/gemini.js` (no shell, no `.cmd` shim), with `GEMINI_CLI_NO_RELAUNCH`.
- **Our own limits:** turn limit through `model.maxSessionTurns`; the timeout and budget stop are enforced by the hive (Gemini has none).
- **Effort:** mapped to the thinking level or budget in the run's settings.
- **Prompt:** the role brief goes in the prompt. `GEMINI_SYSTEM_MD` isn't used, because it would replace Gemini's own system prompt.
- **Sign-in check:** no command exists, so it reads only `security.auth.selectedType` from `~/.gemini/settings.json` and whether the credentials file exists. It never opens the credentials themselves.
- **Cost:** Gemini reports tokens but no cost. The Treasurer estimates cost from a price table, and the UI labels it "estimated".
- **Install with consent:** `npm install -g @google/gemini-cli` (Node ≥ 20), pinned to a version at least 2 weeks old.

### Milestone B: The Brain grows up

| # | Step | Package | Done when |
|---|---|---|---|
| B1 | **Local embeddings + hybrid search** (01-E11, R3, R7) | `brain`, `desktop` (host) | Meaning-search tests on real Brain data; search latency measured |
| B2 | **Ranking, decay and dedupe** (01-E5, E7, E9) | `brain` | Table tests for rank, decay and merge; nothing is ever deleted |
| B3 | **Lessons register, health score, Librarian** (01-E10, E12) | `brain`, `harness` | Lessons appear in the next brief; health score computed; Librarian tests |
| B4 | **Code map** (01-E3, D6) | `codemap` (new) | Map of this repo built; refresh touches only changed files |
| B5 | **Brain screens** (01-D10–D13) | `desktop` | Playwright tests per view |

**B1, local embeddings + hybrid search:**
- A spike first: transformers.js on `onnxruntime-node` vs the WASM backend, inside the Electron utility process, on Windows, macOS and Linux. Pick by "works everywhere", start time and speed.
- Model candidates: `bge-small-en-v1.5` (384-d, quantized) with `all-MiniLM-L6-v2` as fallback, chosen by retrieval quality on our own records.
- Vectors are stored as BLOBs in the same `brain.db` (one file, one transaction, one writer), searched by brute force.
- Keyword (FTS5) and meaning results are merged with Reciprocal Rank Fusion (k = 60; idea from the ruvector review). An approximate index is considered only past about 100k records.
- The model is embedded in the host, off the UI thread, and re-embedding runs in the background.

**B2, ranking, decay and dedupe:**
- Use-based ranking: track reads and "helped". Importance = recency + frequency + fit, and trust weight = confidence × reliability × freshness half-life (ruvector ideas).
- Unused memories fade to archive, never deleted.
- Near-duplicates are merged on write by similarity; the old one is kept as a version.
- Facts get valid-from / valid-to, so superseded facts become history.

**B3, lessons register, health score and Librarian:**
- Failed and retried cards become "don't do X because Y" lessons, shown at boot.
- Health score: stale %, conflicts, orphans, unused records, last audit.
- **Librarian** manager: reflexes (dedupe, decay, audit on a schedule) plus a brain (consolidation proposals), with any change to confirmed facts going to the user.

**B4, code map:**
- tree-sitter via its WASM build: no native modules, matching the `node:sqlite` choice.
- TS/JS and Python first. Per file: symbols, imports and calls, and a one-line purpose written lazily by AI when a goal needs it (08-D6).
- Refreshed by content hash.
- A `brain_code` MCP tool and a `brain code` CLI command, so agents look code up instead of reading whole files.

**B5, Brain screens:**
- **Graph view:** custom; nodes by kind, edges only from real links.
- **Reader with edit:** user edits are confirmed; a conflict shows when an agent changed the same record.
- **Health dashboard and lessons list.**

### Milestone C: The full hive

| # | Step | Package | Done when |
|---|---|---|---|
| C1 | **All 8 castes + library activation** (03-D3, D7, D8) | `harness`, `desktop` | The Queen plans a 3-caste goal; activation tests; Library e2e |
| C2 | **Managers' brain side** (02-D8) | `harness` | Scripted tests per manager with FakeEngine |
| C3 | **Skill proposals and imports** (03-D5, D6) | `harness`, `library` | A repeated pattern produces a proposal; a malicious import is caught |
| C4 | **UI:** the living-hive honeycomb (pauses when hidden, reduced motion honoured); Budgets screen (goal, agent and subscription budgets with charts, Treasurer routing history); Connections finished (engines, providers, services, Vault) | `desktop` | Playwright tests; screenshots |
| C5 | **Full onboarding** (08): the engines step for several engines, providers, all presets, and the optional sample goal on a practice project, with its token cost shown first (08-D8) | `desktop` | First-run e2e with two engines |
| C6 | **Phase 2 demo** | — | The goal at the top works end to end with real Claude Code and Gemini CLI |

**C1, all 8 castes + library activation:**
- Castes: Coder, Tester, Reviewer, Researcher, Documenter, Designer, Analyst, Writer.
- Each caste has its role, default skills and network policy.
- The Queen plans across castes.
- The dormant catalog is searchable. Skills are switched on for a card and off afterwards, and each insect starts fresh with the Brain's task brief.
- Library screen: catalog, active / dormant / draft, filters.

**C2, managers' brain side** (in the order chosen above), with every report going through the Queen (02-D4):
- **Watchdog breaker ladder:** warn → pause the card → stop the agent → pause the hive.
- **Scout:** surveys the code base (using the code map) before the Queen plans.
- **Foreman brain:** decides on stuck cards and reassignment.
- **Periodic reviews**, every N finished cards.

**C3, skill proposals and imports:**
- Repeated successful work (3+ times) → the Librarian drafts a skill → the user approves.
- Failing or unused skills are proposed for retirement.
- Imported skills are scanned (hidden instructions, exfiltration, risky scripts, secrets) before approval.

## Research findings

**Gemini CLI** (researched 2026-11-12 against v0.68.0, released 2026-11-10; checked in the source, since parts of the docs are stale):
- **Headless:** `-p` (stdin is read too) with `-o stream-json`.
  - Events: `init` (session, model), `message`, `tool_use`, `tool_result`, `error`, and `result` with stats: input, output and cached tokens, per-model counts, duration, tool calls.
  - **No cost is reported.**
  - Exit codes: 0 ok, 1 error, 42 input error, 53 turn limit.
- **Models:** `-m auto|pro|flash|flash-lite` or a concrete id; aliases resolve per account. Thinking is controlled only through settings (`thinkingLevel` / `thinkingBudget`), not a flag.
- **Permissions:**
  - `--approval-mode default|auto_edit|yolo|plan`. In headless mode an "ask" counts as **deny**.
  - Policy engine (TOML rules) per run with `--admin-policy`. It is ignored if the machine has its own admin policies in `C:ProgramDatagemini-clipolicies`, so the adapter checks for that and refuses to run unguarded.
- **Hooks:** a `BeforeTool` hook exists, but it **fails open**.
  - A timeout, a spawn error, empty output or exit 1 lets the tool run.
  - Hooks are skipped entirely in untrusted folders.
  - The user's own hooks also run, because hook lists are concatenated.
  - So it can't be the guard. → Safety comes from the policy plus our MCP tools (A2).
- **Config isolation:** there is no `--settings` flag. `GEMINI_CLI_SYSTEM_SETTINGS_PATH` merges last; `-e none` and `--allowed-mcp-server-names` keep the user's extensions and servers out.
- **Sign-in:** no status command; inferred from `~/.gemini/settings.json` (`security.auth.selectedType`) and whether the credentials file exists.
- **Quotas with a Google sign-in:** AI Pro about 1,500 and Ultra about 2,000 requests a day.
- **Privacy:**
  - Gemini CLI always records chats to `~/.gemini/tmp/…`, with no switch to turn that off. The Connections screen will say so.
  - `privacy.usageStatisticsEnabled` defaults to true; the hive sets it to false for its runs.
- **Install:** npm only on Windows (no native exe). Spawn `node bundle/gemini.js` directly; set `GEMINI_CLI_NO_RELAUNCH`.
- **Verdict:** usable with the guard enforced fail-closed through policy + MCP tools. If a check fails (for example, machine admin policies are present), Gemini runs only read-only castes (`--approval-mode plan`).

## Consent points (the user decides each one, when it comes up)

- **Installing Gemini CLI.** The exact command is shown first (04-D6).
- **Downloading the embedding model.** Already approved; the source and checksum are shown when it runs.
- **Real-engine smoke tests and the C6 demo.** They spend subscription usage, so a cost estimate comes first, as in Phase 1.
- **Adding API providers or service keys** (GitHub, search). Optional; the user enters keys in the Vault UI, never in chat.

## Not in Phase 2 (by design)

- Cadence: schedules, triggers and the digest (Phase 3).
- Installers and auto-update (Phase 3).
- Container sandbox (Phase 4).
- Globe, dashboard and timeline Brain views; the ask-the-brain box (Phase 4).
- A Codex adapter until there's a plan to test it against.

## Progress

- **A0 Phase 1 leftovers: done (2026-11-12).**
  - **Effort always "high":** not the engine. The Hive monitor showed the effort the hive *requested*; Claude Code doesn't report effort. The router gives high-priority cards high effort, and the Queen had marked both demo cards high priority.
    - The UI now says "model as reported by the engine; effort is what the hive asked for", and the README is corrected to match.
    - The Queen's prompt now says to use normal priority by default, with "high" only when other work waits on a card or it is risky.
  - **Plan card:** the Queen writes a one-line `headline` (older plans derive it from the summary's first sentence), and the long summary sits behind "Details". The prompt tells her not to write approval wording, since the hive decides that.
  - **Brain crash:** a new e2e test (`brain-crash.spec.ts`) kills the Brain host process. A new process starts, the saved data is still there, and the hive accepts a goal. Passes 3/3 repeated.
