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
- **A1 Engine registry + Connections screen: done (2026-11-12).** Built by two parallel workers on a shared contract (`EngineCardSchema`, `snapshot.engines`, `setEngineEnabled` / `setEngineOrder`). 456 unit tests and 45 e2e tests pass.
  - **Harness:**
    - **Adapters:** each `EngineAdapter` declares its capabilities (how the guard protects runs, MCP, effort levels, whether cost is reported), models by tier, install and sign-in text and a privacy note.
    - **Registry:** `EngineRegistry` keeps the user's order, on/off switches and detections; `RegistryEngine` sends each run to the adapter its route names (`Route.engine`).
    - **Adapters today:** Claude Code (real), the scripted test engine, and Gemini CLI, Codex and OpenCode listed as "not available yet", with real install text.
  - **Routing rule (`pickEngine`):** the first engine in the user's order that is on, ready and guarded. An engine that's only safe read-only never gets work that changes files (the Inspector counts as a writer). Per-caste routing and learning come in A5.
  - **Host:**
    - The registry replaces the single engine.
    - Engines are checked at start and every 60 s while any enabled one isn't ready.
    - Order and on/off switches are saved.
    - Switching off the only ready engine is refused while a goal runs.
    - In scripted mode Claude can never run, so no test can spend real tokens.
  - **Connections screen** (shadcn `button`, Kokonut `inline-alert`; custom accessible switch, since Kokonut's `switch-button` is a theme toggle). One card per engine:
    - state and version;
    - a "Default" badge;
    - safety in plain words;
    - cost reported or estimated;
    - models by tier;
    - privacy note;
    - copyable install and sign-in commands;
    - an on/off switch and Move up / Move down.

    The API providers, Services and Vault tabs show "Later". Hive lanes now name the engine that ran them.
  - **Fixed after the screenshot:** unsupported engines said when they're coming twice. Screenshot: `design/screenshots/phase-2-a1-connections.png`.
- **A2 Gemini CLI adapter: built (2026-11-12); the real smoke test is waiting for the user's go-ahead.** 490 unit tests and 45 e2e tests pass.
  - **Install:** Gemini CLI 0.66.0 was installed with the user's consent. Gemini **updated itself to 0.68.0** when the user ran it to sign in (its own auto-update). Every flag was verified in that 0.68.0 bundle, so the minimum is 0.68.0, and hive runs now set `general.enableAutoUpdate: false`. 0.68.0 is younger than our 2-week rule; that's the user's call.
  - **`packages/hive-tools-mcp` (new, 13 tests):** guarded `read_file`, `list_dir`, `glob`, `search`, `write_file`, `edit_file` and `run_shell`.
    - **Guard:** runs inside before every action; reads outside the workspace are refused too; any error refuses.
    - **Shell:** PowerShell on Windows (real exit codes), `/bin/sh` elsewhere.
    - **Child processes:** never inherit `ELECTRON_RUN_AS_NODE`, the guard policy or the Brain token. Timeouts kill the whole process tree.
  - **Gemini adapter** (`packages/harness/src/gemini/`, 21 tests):
    - **Detection:** finds the install and reads the sign-in type only; the credentials file is never opened.
    - **Per-run config:** a system settings file, `-e none`, only the `hive` and `brain` MCP servers, `--skip-trust`, a unique context file name, usage statistics off, overage never, auto-update off, turn limit.
    - **Stream reader:** converts Gemini's stream into the hive's events. Cost is estimated from a price table and marked as estimated.
    - **Exit codes:** 41 auth, 53 turn limit, 54 tool error, 55 untrusted folder.
  - **Differences from the 0.68.0 research that changed the design:**
    - Gemini **blocks `ELECTRON_RUN_AS_NODE`** in MCP server env, so Gemini and its MCP servers run on the system Node.js (≥ 20), never on the app's executable.
    - Server env values are expanded (`$VAR`, `%VAR%`), so runs with such values are refused.
    - The guard hook layer is dropped: Gemini's tool names don't fit our hook, and hooks are switched off entirely for hive runs (`hooksConfig.enabled: false`), the user's own included.
  - **Safety layers:**
    1. A per-run **admin policy** denies every built-in Gemini tool and allows only the `hive` and `brain` MCP servers.
    2. The **hive tools** run the guard inside themselves.
    3. **Without the hive tools bundle**, Gemini is read-only (plan mode, built-in reads only, secret files denied) and refuses writer roles.
    4. **Machine admin policies** (which would override ours) make Gemini report itself unusable.
  - **Real detection** (no prompt sent): ready, signed in with Google, Node 24.15, guard `policy-and-tools`.
  - **Notes:**
    - In Gemini runs, the `brain` CLI isn't reachable from the hive shell (its token is scrubbed); the Brain MCP door works.
    - A blocked engine (machine policies, unsafe env) shows as "missing" with the reason in its message; the contract has no separate "blocked" state yet.
  - **Real smoke test (user approved, 2026-11-12): Google refused the sign-in, before anything ran.** All flags were accepted, and no quota was used.
    - **The error:** "IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals… migrate to the Antigravity suite."
    - **Confirmed in Google's announcement** (github.com/google-gemini/gemini-cli/discussions/27274, 2026-05-19): since **2026-06-18, Gemini CLI no longer serves Google AI Pro, Ultra or free use**. It still works with **paid Gemini API keys** and enterprise licenses. The replacement for personal plans is **Antigravity CLI** (`agy`, written in Go). Its headless mode, MCP, hooks and policies aren't documented yet, and users report sign-in and MCP problems.
    - The A2 research checked flags but missed this; it was found by the first real run.
    - **Fixes:**
      - A personal Google sign-in now shows Gemini as **signed out**, with this explanation, instead of "ready".
      - The sign-in note on the Connections card says a paid API key is needed.
      - Gemini detection no longer runs `npm root -g` through a shell on Windows; it uses the default npm folder and a PATH scan instead (no shell anywhere).
    - **Open decision for the user:** a paid Gemini API key (works with this adapter as built, billed per use, stored in the Vault from A3), or a new Antigravity CLI adapter (would use the paid plan; needs research first), or Gemini later.
    - **User decision (2026-11-12): leave Gemini for now.**
      - The adapter and the hive tools stay in place and tested; the Gemini card shows why it can't run.
      - Gemini CLI 0.68.0 stays installed and does nothing on its own.
      - **The Phase 2 demo's "2 engines" goal is on hold** until a second engine is chosen: Antigravity CLI once it's documented, a paid Gemini API key, or an OpenCode provider (A4).
      - **Next: A3** (Vault + secret broker).
- **A3 Vault + secret broker: done (2026-11-12).** Built by two parallel workers on the shared contract `packages/shared/src/vault-api.ts`. 513 unit tests and 51 e2e tests pass. No real key was ever used: tests use made-up values and a fake local server.
  - **Vault** (main process, `main/vault.ts`):
    - `safeStorage` ciphertext only, in `<userData>/vault.json`; fails closed without OS encryption.
    - The UI sees only a label, a 4-character hint and a handle. The key is decrypted only inside main, when the broker needs it.
    - Removing a key is refused while an enabled service uses it.
  - **Services** (`main/services.ts`): GitHub (bearer, GET/HEAD) and Brave Search (`X-Subscription-Token`, GET) are built in and off by default; users can add https REST services. A "Test connection" makes one harmless read through the broker.
  - **Secret broker** (`main/broker.ts`): 127.0.0.1, random port, `POST /call` with a capability token. Each property has its own test (14 tests):
    - **No key leaks:** a planted key appears in no IPC reply, log or audit entry, and an echoed key is redacted (even when split by the size cap).
    - **Header stripping:** the key is added by the broker, and cookie/host-style headers from the caller are dropped.
    - **Tokens:** missing, unknown, revoked or expired tokens are refused.
    - **Scope:** a token reaches only services that are both granted for its card and switched on.
    - **Path tricks:** `..`, `%2e%2e`, `//`, backslashes, full URLs and `?` in the path are refused before any request goes out.
    - **Write methods:** answer 403 with a BLOCKED hint unless the user approved "publish" for that card.
    - **Size cap:** bodies are capped at 200 KB; no CORS headers.
  - **Tokens per run:**
    - A new host → main channel (`broker.issue` / `broker.revoke`).
    - Only insects whose card lists `integrations` get a token; the Queen, the Inspector and other cards never do.
    - Revoked in `finally`, with a 2 h maximum life.
    - The token reaches only the new `services` MCP server (`packages/services-mcp`, one tool: `call_service`), for Claude and Gemini runs alike; never the engine or the shell.
  - **Queen:** plan cards gain `integrations`; the Queen's brief lists the services that are switched on and tells her to give a card only what it needs.
  - **UI:**
    - **Vault tab:** the key input is uncontrolled, so the key never enters React state, and it clears on save; there's a hold-to-remove.
    - **Services tab:** key picker, on/off switch with consent wording, test connection, and an "Add a service" form (https only).
    - **Card detail:** lists the card's services.
    - Uses Kokonut `hold-button` and `inline-alert`, and shadcn `button`.
    - An e2e test proves the planted key never appears in the page text or any input.
  - **Screenshots:** `design/screenshots/phase-2-a3-services.png`, `phase-2-a3-vault.png`.
- **A4 API providers + OpenCode: built (2026-11-12); the real run waits for an OpenCode install and a provider.** Built by three parallel workers after a research pass. 545 unit tests and 58 e2e tests pass. OpenCode isn't installed; everything is tested against a fake OpenCode binary and a fake OpenAI-compatible server, with made-up keys.
  - **Research:** OpenCode is alive, MIT-licensed and renamed (`anomalyco/opencode`). **Version 2 is a rewrite**, now `@opencode/cli`. The pinned version is **2.2.1**, the newest at least 2 weeks old; the 2.x line changes fast and breaks in minor versions.
  - **Providers** (main, `providers.json`; contract `packages/shared/src/providers-api.ts`):
    - Presets: OpenRouter, FreeLLMAPI (with its personal-use note), Ollama, LM Studio, and any OpenAI-compatible service.
    - Remote providers need https; local ones (127.0.0.1 / localhost) may use http and are badged "nothing leaves this PC".
    - The test lists models through the broker.
    - Keys stay in the Vault; providers in use can't be removed or switched off.
  - **Broker LLM route** (`/llm/<provider>/…`):
    - **Passes:** one provider per pass; the broker swaps in the Vault key, so the engine only holds a 2-hour pass, revoked when the run ends.
    - **Paths:** only `/chat/completions`, `/completions`, `/models`, `/responses` and `/embeddings`.
    - **Streaming:** streams pass straight through. The key is redacted even when it's split across chunks; one call at a time per pass; 10-minute timeout; the upstream call is cancelled when the engine disconnects.
    - **Usage:** records the model that actually answered and the tokens, which is the hive's source of truth.
  - **OpenCode adapter** (`packages/harness/src/opencode/`), verified against the 2.2.1 source:
    - **Run:** `run --standalone`, so it never uses the user's shared background service.
    - **Config:**
      - passed as text through an environment variable;
      - the user's config, project config, machine config (`ProgramData` redirected per run; refuses on macOS/Linux if a system config exists), plugins and auto-update are all kept out;
      - the session database is in memory.
    - **Tools:**
      - deny-all permissions plus our own `hive` agent;
      - the built-in tool plugins never load;
      - provider and MCP policies allow only ours;
      - the only tools left are the guarded `hive`, `brain` and `services` MCP tools;
      - read-only fallback.
    - **Never** passes `--auto`, `--yolo` or `--dangerously-skip-permissions`; a test checks this.
    - **Two new risks found in the source and closed:**
      - OpenCode substitutes `{env:…}` / `{file:…}` anywhere in its config, so the prompt goes only on stdin and such values are refused.
      - A card title starting with `-` could have been read as a flag, so leading dashes are stripped.
    - **Host:** a pass per run through `broker.issueLlm`; usage read through `broker.llmUsage`; revoked in `finally`. Main answers `providers.ready` with metadata only (never a key or its handle; tested).
  - **UI:** the API providers tab is live, with presets, a Vault key picker, a model per tier (suggestions after a test), on/off, test and hold-to-remove. **No Connections tab says "Later" any more.**
  - **Screenshot:** `design/screenshots/phase-2-a4-providers.png`.
  - **To run for real:**
    - install OpenCode (`npm install -g @opencode/cli@2.2.1`, about 250 MB; its install script runs PowerShell to copy the program) with the user's consent;
    - add a provider (a local Ollama model is free and private);
    - then run the opt-in smoke test.
- **A5 Treasurer v2: done (2026-11-12).** Built by two parallel workers on the contract additions (`EngineCard.usage`, `AgentView.routeReason`, `setEngineLimits` / `clearEngineLimitHit`). 577 unit tests pass; the e2e suite passes 65/65 twice in a row.
  - **Outcomes in the Brain** (migration v4, `run_outcomes`):
    - one row per run: engine, tier, the model that actually ran, effort requested, attempt, result, tokens, cost (with an estimated flag), duration;
    - the Inspector's verdict turns a card attempt's runs into pass or fail;
    - limit, sign-in and stopped results never count against a model.
  - **Learning router** (`harness/hive/treasurer.ts`, deterministic with a seeded RNG):
    - **Candidates:** the rule route plus one tier or one effort level either way, on every allowed engine.
    - **Belief:** Beta(success+1, fail+1) per caste × engine × tier × effort, with Thompson sampling.
    - **Trust:** at least 5 finished runs before a candidate counts.
    - **Choice:** the **cheapest option whose sampled success ≥ 0.8** wins.
    - **Unchanged:** retries still escalate; the Queen and the Inspector stay on the rule route.
    - **Plain-words reason on every lane:** "rule: …", "learned: …" or "fallback: …".
  - **Usage and limits:**
    - Rolling 5 h and 7 d use per engine; the user's own US$ caps.
    - **Near (80%):** the engine is used only as a fallback, and the insect cap drops to 1 when every usable engine is near.
    - **Exhausted:** the engine isn't used at all.
    - **Vendor limits:** usage, rate-limit and quota messages and HTTP 429 are detected in the engines' output, with the reset time parsed when given (otherwise 1 h).
      - The card is put back **without using an attempt** and keeps its work for the next engine.
      - The Queen re-plans elsewhere.
      - With no engine left, the hive pauses and resumes once one frees up.
  - **UI:**
    - Engine cards show 5 h / 7 d meters (cost marked "≈ estimated" when the engine didn't report it), "Set limits" and "Clear limit", and say plainly that the hive can't see the vendor's real quota.
    - Hive lanes show "Why this model".
    - The side panel warns when an engine is near or at a limit.
  - **Flaky test check:** `brain-crash.spec.ts` failed once while two runs overlapped; it passed in both full sequential runs.
- **B1 Local embeddings + hybrid search: done (2026-11-12).** 616 unit tests and 72 e2e tests pass.
  - **No native modules:** `onnxruntime-web` 1.31.1 runs the model in WebAssembly, with `@huggingface/tokenizers` 0.2.0 (both MIT/Apache, both pass the 2-week rule). `@huggingface/transformers` was rejected: it pulls in native `sharp` and `onnxruntime-node` (300+ MB). protobufjs's install script only prints a warning and stays blocked (`allowBuilds: protobufjs: false`).
  - **Spike** (user approved downloading both candidates, about 58 MB): pinned Hugging Face revisions, SHA-256-checked, evaluated on 168 passages from this repo with 50 queries (40 paraphrases written to avoid the passages' words).

    | Search | recall@5 | paraphrases | keywords |
    |---|---|---|---|
    | FTS5, every word must match (before B1) | 0.19 | **0.00** | 0.93 |
    | FTS5, any word | 0.58 | 0.48 | 1.00 |
    | bge-small | 0.62 | 0.54 | 0.95 |
    | MiniLM | 0.64 | 0.57 | 0.93 |
    | **any word + MiniLM (RRF)** | **0.66** | **0.58** | **1.00** |

    **Winner: all-MiniLM-L6-v2** (23.7 MB; 5 ms per query, 65 ms per record). bge-small was 3–4× slower and used about 560 MB more memory, so its files were deleted. The int8 model's vectors shift slightly with their batch neighbours, so the batch size is 1 (deterministic, and also faster).
  - **Brain** (migration v5, `record_vectors`):
    - int8 vectors per record and model; a vector counts only while the record's content hash matches.
    - Search is now hybrid: **any** meaningful word (stop words dropped), plus a cosine search when there's a query vector (floor 0.25), merged with RRF (k=60).
    - Every hit says `words | meaning | both`.
    - Shelf scoping unchanged.
    - `read()` and the Queen's lookups use hybrid search.
  - **Host:**
    - Meaning search is **off by default**.
    - Turning it on downloads the model only if it's missing, then indexes in the background one record at a time.
    - Agents get meaning search through MCP and the `brain` command; they never send vectors.
    - A search round trip in the app took 11 ms.
    - The packaged-app path for the WASM file is a Phase 3 TODO.
  - **Downloads in tests:**
    - While the UI was being built, an e2e test pressed "Turn on" on a fresh test profile and the app **downloaded the approved MiniLM model once into that temporary profile**. The test was removed.
    - The backend now refuses downloads under e2e or vitest unless `INSECTOIDS_ALLOW_MODEL_DOWNLOAD=1` is set, proven by a unit test and an e2e test.
    - It reports `needs-download` when the model isn't present, so the consent text is exact.
  - **UI:**
    - **Brain screen:** a meaning-search strip whose consent line states model, size and source before any download, then download progress / "Reading your Brain: n of m" / on; and a match badge on every result.
    - **Hint:** "Try meaning search" when a sentence finds nothing.
    - **Settings:** a Meaning search block.
- **B2 Ranking, decay and dedupe: done (2026-11-13).** Paused on 2026-11-12 and finished the next day. 659 unit tests pass three runs in a row with no unhandled errors; e2e 79 passed, 2 skipped.
  - **Usage** (migration):
    - reads per record, counted only when an agent actually *reads* it (`get`, `read()`, boot card and the Queen's lookups), never for showing up in a search;
    - "helped" when a run that read it passes inspection (`cardReadKey` per card attempt).
  - **Importance** (`packages/brain/src/importance.ts`): recency with a freshness half-life, log-scaled reads and the helped ratio, times a trust weight (confirmed 1.0, unconfirmed 0.8, proposed 0.7) and confidence. Search ranking = hybrid RRF × (0.7 + 0.3 × importance), so relevance still leads.
  - **Time-aware facts:** `validFrom` / `validTo`, `supersede()` and the `supersedes` link. Default search shows current records only; `includeHistory` adds replaced and archived ones, each marked.
  - **Near-duplicates:** same shelf and kind; cosine ≥ 0.95 with vectors, else trigram Jaccard ≥ 0.9; and **the numbers in both texts must match**, so facts with different numbers never merge.
    - An agent near-duplicate of an agent record folds in as a new version; the incoming text is kept as an archived "merged into …" record.
    - A near-duplicate of a user-confirmed record changes nothing.
  - **Decay** (host job: at start and every 6 h, plus "Tidy now"):
    - fades only agent-made `update` / `agent_memory` / `outcome` records unused for 60 days, and agent facts still unconfirmed after 90 days, and only when importance < 0.15;
    - never decisions, tasks or files, never anything the user wrote, confirmed or ever edited;
    - the reason is recorded ("faded: unused for N days").
  - **Restore:** user only (`unarchive`, a user-only method on the Brain service; `restoreRecord` in the app), as a new version.
  - **Rules checked in the code, not just the tests:**
    - nothing is deleted;
    - agents can't change, merge away, replace or fade what the user confirmed (they propose instead);
    - the secrets guard runs before every write, merge and replace path.
  - **UI:**
    - the Brain reader shows the usage line and importance meter, "Current since / Replaced on … by …", "Replaces", "Merged from", and the archive reason with a working **Restore** button;
    - search has an "Include history" toggle with "replaced" / "faded" badges;
    - an intro line explains how the Brain keeps itself tidy.
  - **Bug found while finishing B2 and fixed:** shutting the hive down didn't wait for running agents. In the app, a run could write spending to the Brain after it closed, or clean up a workspace copy after its folder was gone (seen as unhandled errors after tests).
    - `Hive.settle()` stops running agents and waits for their bookkeeping.
    - The host waits for it, the Foreman pass and background planning (capped at 30 s) before the project and the Brain close.
    - A regression test fails without the fix and passes with it.
  - **Environment note:** the Windows clipboard on this PC refused writes during the final runs (even PowerShell's `Set-Clipboard` failed). The copy-command e2e test now probes the clipboard first and skips with that reason instead of failing falsely.
- **B3 Lessons register, Brain health, Librarian: done (2026-11-13).** Built by two parallel workers on the contract additions (record kind `lesson`; `snapshot.brainHealth`, `librarian`, `lessons`; `runLibrarian`, `confirmLesson`, `retireLesson`). 701 unit tests pass in two runs with no unhandled errors; e2e 88 passed, 2 skipped. No real engine runs; the Librarian's AI review is tested with the scripted engine.
  - **Lessons:**
    - Every failed inspection (retried or escalated) writes an **unconfirmed** lesson, "Don't hand in "<card>" as done because <Inspector's reason>", with no AI involved.
    - The same failure folds into the same lesson and raises `seen`.
    - The boot card lists confirmed lessons first, then up to 3 recent unconfirmed ones; briefs get relevant lessons through hybrid `read()`.
    - The user can **confirm** (then it never fades) or **retire** (archived "retired by you", restorable).
  - **Health score:** 100 − capped penalties, floored at 0, `null` before the first audit:
    - stale (unused 90+ days): 0.4 per %, cap 25;
    - waiting for the user: 2 each, cap 20;
    - orphans: 0.3 per %, cap 15;
    - never read: 0.25 per %, cap 15;
    - duplicates only the user can merge: 3 each, cap 15;
    - unconfirmed lessons > 14 days: 2 each, cap 10.
  - **Librarian** (manager, "reflexes + brain", D8):
    - **Free audit** (plain code): at start, every 6 h, and on demand. It runs B2's fading (only while idle), finds duplicates only the user can merge, and scores health.
    - **AI review:**
      - **When:** after 20 finished cards or a week, only with an engine ready, no agents working and the hive not paused, or when the user asks.
      - **How it runs:** read-only Brain token, no workspace writes, no network; standard tier at low effort, routed by the Treasurer.
      - **What it can do:** propose at most 10 merge / supersede / confirm / archive changes. Each becomes an approval "from Librarian" and is applied **as the user only on yes**; the Librarian never changes user records itself.
      - **Bad replies:** a malformed reply gives no proposals and one activity line.
    - Its summary reaches the user as one Queen activity line (D4).
    - `library/agents/librarian/AGENT.md` was rewritten to describe exactly what the code does, plus the JSON contract.
  - **UI:**
    - **Brain screen row:**
      - Health panel: score with Tidy / Fair / Needs care, a meter, a breakdown under "What makes up the score", and "Check now" (free).
      - Librarian card: its state, last and next review, suggestions waiting (opens Approvals), and "review now" with a note that it uses a little of the AI subscription.
      - Lessons list: Confirm, and hold-to-Retire.
    - The Hive monitor labels Librarian runs.
  - **Regression found while integrating and fixed:**
    - **The bug:** the new start-up audit ran *after* the e2e seed. With the 90-day test clock, it faded the freshly seeded records, so three B2 e2e tests found nothing.
    - **The fix:** the audit now runs before seeding, with a host regression test; the B2 tests weren't changed.
- **B4 Code map: done (2026-11-13).** Built by two parallel workers (map and doors; Brain screen view) on the contract additions (`snapshot.codeMap`, `rebuildCodeMap`, `HiveApi.codeLookup`, `HIVE_IPC.codeLookup`). Unit tests: 727 pass with no unhandled errors. e2e: 97 passed, 2 skipped by design, in three full runs in a row. No AI, no network, no real engine runs.
  - **Parser:** `@vscode/tree-sitter-wasm` 0.3.1 (Microsoft, MIT, no install scripts; it bundles `web-tree-sitter` and the grammar WASM files). No native modules, matching `node:sqlite`. New package `packages/codemap`.
  - **What it reads:**
    - TypeScript (`.ts .mts .cts`), TSX, JavaScript (`.js .mjs .cjs .jsx`) and Python. `.d.ts` files are skipped as types only.
    - Per file it stores symbols (function, class, method, interface, type, enum, variable, module) with lines, signature, parent and the first sentence of the doc comment, plus imports (resolved to project files where possible) and calls (caller → callee, resolved to a file when the import says so).
  - **Storage (migration v8):** `code_files` (with content hash), `code_symbols`, `code_edges` and `code_map_state`, on the project's shelf. The Brain host stays the single writer.
  - **Refresh:**
    - **File list:** `git ls-files`, giving tracked files plus untracked files that `.gitignore` doesn't exclude. Files over 512 KB are skipped and counted.
    - **What gets re-read:** only files whose content hash changed. Deleted files are forgotten, and changing the extract version re-reads everything once.
    - **When:** it builds when a project opens, refreshes every 10 minutes while the hive is idle, and rebuilds on demand. The work goes file by file with yields, so the hive never waits on it; one bad file is logged, never fatal.
    - **Measured on this repo:** 298 files and 1,717 symbols in 1.44 s; a refresh with nothing changed takes 0.30 s.
  - **Doors** (agents look code up instead of reading whole files):
    - MCP tool `brain_code`, with modes symbol / file / callers / callees;
    - CLI `brain code <query> [--file | --callers | --callees]`;
    - app IPC `codeLookup`.
  - **UI:** a Notes | Code switch on the Brain screen. Code shows the map's state, languages and counts, a lookup box with the four modes, and "Rebuild".
  - **Not built yet:** the one-line AI "purpose" per file (08-D6), to be written lazily when a goal needs it. The doc comment's first sentence stands in for now.
  - **Fixes found while integrating (all e2e flakes under parallel load):**
    - **The Brain restart race:**
      - **The bug:** a call made while the Brain host was restarting after a crash failed with "The Brain host stopped." After a crash the state is `failed`, with a retry already scheduled.
      - **The fix:** `BrainHost.call()` / `read()` now wait (up to 15 s) for a host that is coming back, and retry read-only calls once after a restart. Every Brain status change is pushed to the renderer, so the status line updates at once. The crash test now searches immediately after the kill.
    - **Hold-to-confirm buttons:**
      - **The bug:** the hold only completed when its fill animation finished, and a busy or background window can pause animation frames.
      - **The fix:** completion now follows a plain timer, and the fill is only visual (a change to the Kokonut UI `hold-button`).
      - **The tests:** they hold until the button reports `data-complete` (`e2e/support/hold.ts`), pinned to one element, since some buttons rename themselves mid-hold. They no longer use a fixed 1.5 s wait. If the page shifts and the button rightly cancels the hold, the helper measures it again and presses again.
