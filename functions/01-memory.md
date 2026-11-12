# 01 — Memory (Second Brain)

**Status:** Finalized (2026-11-12)
**Created:** 2026-11-12
**Last updated:** 2026-11-12

---

## Purpose

A shared "second brain" for the whole system. It stores files, decisions, updates, completed work and pending work in one place, so that agents do not have to re-read chat history, source code or documents to understand what is going on. This saves time and tokens.

## Goals (set by user, 2026-11-12)

1. **Fast** — answers in milliseconds, no waiting on networks or models.
2. **Efficient** — small storage, little compute, no duplicate work.
3. **Effective** — returns the *right* information, current and trustworthy.
4. **Lowest token wastage** — agents load only what they need, in compact form.
5. **Best memory management** — nothing lost, nothing stale, nothing bloated.

## What the user asked for (original words, summarized)

- Stores **all files, decisions, updates, work done and work to be done**.
- Organized as **tables and graphs**.
- Lives in **our own database** (self-owned, not a third-party memory service).
- **Every agent and subagent** can read it and write its own memory into it.
- Goal: **avoid re-reading chat context, code, etc.** → save time and tokens.

## How it works (current understanding)

1. When an agent finishes something meaningful (a decision, a change, a task), it writes a record to Memory.
2. When an agent starts a task, it queries Memory first instead of reading raw chats or code.
3. Memory returns compact, structured answers (rows, linked items), not whole documents.

## What it stores (draft categories)

| Category | Example |
|---|---|
| Files | Path, purpose, short summary, last changed, owner |
| Decisions | What was decided, why, by whom, date, what it replaces |
| Updates | What changed, where, when, by which agent |
| Work done | Completed tasks, results, links to related files |
| Work to be done | Open tasks, priority, assignee (agent), blockers |
| Agent memory | Per-agent notes, learned preferences, context |

## Inputs / Outputs

- **Inputs:** writes from agents/subagents and from the user.
- **Outputs:** query results for agents; views (tables/graphs) for the user.

## Reference: AIS-OS "brain" (github.com/nateherkai/AIS-OS)

The user shared this repo as an example of the brain they have in mind. What it contains:

| Part | What it is | How it saves tokens |
|---|---|---|
| `CLAUDE.md` / `AGENTS.md` | Operating manual: who the user is, folder map, rules, and routes to everything | Agent reads one small map instead of the whole project |
| `context/` | Canonical, confirmed facts about the user, business and priorities | One source of truth, no hunting through chats |
| `decisions/log.md` | Append-only log: Date, Decision, Why, Alternatives, Owner | Agents read *why* something was decided, not the discussion |
| `brainstorms/` | Raw interview captures (`/grill-me`), dated, resumable | Read only on demand; confirmed facts get promoted to `context/` |
| `connections.md` | Registry of external tools: Domain, Tool, Mechanism, Auth, Last checked | Agent knows what it can reach without trying |
| `references/` | Frameworks, voice guide, API guides | Stable reference, loaded only when needed |
| `audits/` | Dated health reports with finding IDs tracked over time | Snapshot of what is broken or stale |
| `archives/` | Retired material, never deleted | Keeps the live brain small |
| `/link` routing | Manual → index → target chain; points to sources, never copies them | Agent follows 2–3 links to the exact file |
| `/3d-brain` | Local 3D globe visualizing notes as nodes, links as edges | Visual only; not a database, writes nothing |

**Key ideas worth keeping:** route, don't copy; raw captures vs confirmed facts; append-only decisions with reasons; archive instead of delete; graph built only from real links.

**Gaps vs what the user wants:** it is plain Markdown files, not a database; no task tracker (work done / to be done); no per-agent memory store; no tables or charts of progress; no rules for many agents writing at once.

## Reference: Ruflo brain (github.com/ruvnet/ruflo, formerly Claude Flow)

A multi-agent "harness" for Claude Code/Codex (100+ agents, swarms). Its brain is a real database, not Markdown files.

| Part | What it is |
|---|---|
| **AgentDB** | Vector database for agent memory, file-based (e.g. `.agentdb/*.db`, `agentdb.rvf`), HNSW index for fast semantic search, optional quantization to shrink it |
| **Memory CLI** | `memory store / get / search / list / delete / export / stats` with `--key`, `--value`, `--namespace` |
| **Namespaces** | Separate shelves, e.g. `patterns`, `coordination` |
| **Memory tiers** | Session (messages), long-term facts (key, value, confidence, source), patterns (trigger → response, success count), semantic (embeddings) |
| **Swarm shared memory** | Key layout `swarm/<agent>/*` (own state), `swarm/shared/*` (everyone), `swarm/broadcast/*` (change notices); agents poll these keys |
| **ReasoningBank** | Learning layer: records each task's approach + outcome (success/fail, metrics), then recommends the best strategy next time |
| **Knowledge graph / RAG** | Plugins for entity-relationship graph and hybrid search with graph hops |
| **Consolidation** | Prunes by importance/relevance; backup and consolidate scripts |
| **Unification (v3)** | Merges 7 older memory systems (incl. SQLite and Markdown backends) into AgentDB |

**Key ideas worth keeping:** one database every agent can query; namespaces per agent/area; semantic (meaning-based) search; agents learn from outcomes; confidence + source on each fact; pruning so memory doesn't bloat.

**Cautions:** speed claims (150x–12,500x) are vendor-reported with no method shown; swarm docs describe conflict handling (CRDTs, vector clocks) but example code doesn't actually implement it; no human-readable tables/dashboard of decisions and tasks; schema docs are thin.

## Reference: Munder Difflin (github.com/HarnessMD/munder-difflin)

Shared by the user as the model for *how users connect their own AI tools*. Desktop app (Electron + TypeScript) that runs many terminal coding agents as a team on the user's machine, each using the user's existing subscription.

- **Connecting tools:** each AI CLI (Claude Code, Codex, Gemini CLI, Cursor, Copilot, Qwen, OpenCode, Kimi, Grok, …) runs as a real terminal process; missing CLIs can be installed and signed into from the app. Also bring-your-own API keys and local models (Ollama, LM Studio, vLLM).
- **Memory:** per-agent Markdown memory, mined into a shared searchable "palace" with semantic recall; a local git "hive" with mailboxes, shared blackboard and append-only event log; `handoff.md` per agent for context across cleared sessions.
- **Other useful ideas:** write-only secret broker for API keys (matches E6); cost ledger and per-agent token budgets; circuit breaker that stops looping or overspending agents.

## Reference: FreeLLMAPI (github.com/tashfeenahmed/freellmapi)

Self-hosted proxy that combines the free tiers of many LLM providers behind one OpenAI-compatible endpoint. Scoped by its author for personal, single-user experimentation. Relevance to the brain: free-tier models often have small context windows, which makes tiered reading and token budgets (E8, D7) even more important.

## Reference: claude-obsidian (github.com/AgriciDaniel/claude-obsidian)

Shared by the user as a model for the brain's GUI. MIT-licensed Claude Code plugin (skills also work in Codex, OpenCode, Gemini, Cursor, Windsurf) that turns an Obsidian vault into an AI-maintained wiki, based on Karpathy's "LLM Wiki" pattern.

- **How it works:** sources dropped in `inbox/` → Claude keeps an untouched copy → writes linked pages with citations → Obsidian shows them as a normal Markdown vault.
- **GUI it relies on (Obsidian's own):** graph view (clusters of linked notes), Canvas (visual knowledge maps), Bases (tables, cards, filters, formulas).
- **Skills:** `wiki-ingest`, `wiki-query` (read-only, cited answers), `save`, `wiki-lint` (dead links, orphans, gaps), `wiki-retrieve` (local keyword/BM25 search), `wiki-fold` (summarize the operation log), `wiki-mode` (filing styles: Generic, LYT, PARA, Zettelkasten).
- **Safe writing (worth adopting):** helper agents are read-only and return drafts; one "transaction core" is the only writer; every note's fingerprint (SHA-256) is checked before writing; changes apply as one transaction with a journal for rollback; if the user edited a note meanwhile, the write stops with a conflict.
- **Citations:** important claims link to their source; weak or conflicting evidence is shown, not hidden.

## AIS-OS vs Ruflo, at a glance

| | AIS-OS | Ruflo |
|---|---|---|
| Storage | Markdown files | Vector database (AgentDB) |
| Human-readable | Yes, open any file | Mostly no, needs CLI/tools |
| Finds things by | Following links (manual → index → file) | Meaning-based search |
| Decisions log | Yes, with reasons | No dedicated one |
| Task tracking | No | Partial (agent state keys) |
| Multi-agent writes | Not designed for it | Designed for it (namespaces, shared keys) |
| Learns from outcomes | No | Yes (ReasoningBank) |
| Visual | 3D note globe | Console UI |

## Best ideas to adopt (proposed)

Both repos are MIT-licensed, so ideas and code can be reused with attribution.

| # | Idea | From | Serves goal |
|---|---|---|---|
| A1 | Route, don't copy: store a summary + pointer to the real file, never the full file | AIS-OS | Tokens, Memory mgmt |
| A2 | Raw notes vs confirmed facts kept separate; facts promoted only when confirmed | AIS-OS | Effective |
| A3 | Append-only decision log with Why + Alternatives | AIS-OS | Effective, Tokens |
| A4 | Archive, never delete | AIS-OS | Memory mgmt |
| A5 | Audit: check freshness and broken links on a schedule, track findings by ID | AIS-OS | Effective, Memory mgmt |
| A6 | Graph edges only from real links, never invented | AIS-OS | Effective |
| R1 | One real database all agents read/write | Ruflo | Fast, Efficient |
| R2 | Namespaces: per-agent, shared, broadcast | Ruflo | Tokens, Efficient |
| R3 | Meaning-based (semantic) search with embeddings | Ruflo | Effective |
| R4 | Every fact carries confidence + source | Ruflo | Effective |
| R5 | Learn from outcomes: record approach + result, recommend what worked | Ruflo | Effective, Efficient |
| R6 | Consolidation: prune/merge low-value memories, TTL on short-lived ones | Ruflo | Memory mgmt, Fast |
| R7 | Fancy vector index (HNSW) only once memory is large; plain search is faster when small | Ruflo (own benchmark note) | Fast, Efficient |

**Skip for now:** 3D globe (later as a dashboard), Ruflo's 100-agent swarm machinery, unverified speed claims, duplicated Claude/Codex skill copies.

## Proposed design (draft, not yet agreed)

- **One local database** (e.g. SQLite) as the single source of truth. No network = fast; one file = easy backup.
- **Tables:** `files`, `decisions`, `tasks` (to do / doing / done), `updates` (change log), `facts`, `agent_memory`, `outcomes`, `links` (graph edges between any two rows).
- **Search, two kinds:** keyword search (full-text) + meaning search (embeddings, computed once on write).
- **Tiered reading to save tokens:**
  1. *Boot card*: a few hundred tokens: current goals, active tasks, last decisions.
  2. *Index rows*: titles + one-line summaries.
  3. *Detail*: one full record, only when needed.
  4. *Source*: open the real file, only as a last resort.
- **Freshness:** each file record stores a content hash; if the file changed, its summary is flagged stale and refreshed.
- **History:** rows are versioned, never overwritten; old rows archived.
- **Views for the user:** tables and charts (dashboard) generated from the same database.

## Enhancements (Tier 1 + Tier 2 accepted 2026-11-12; Tier 3 deferred)

**Tier 1: biggest impact**

| # | Enhancement | What it does | Goal |
|---|---|---|---|
| E1 | Auto-capture & auto-load hooks | Claude Code hooks load the boot card at session start and save work/handoff at session end, so agents never "forget" to use the brain | Effective, Tokens |
| E2 | Handoff checkpoints | Before a session ends or context is compacted, write "where I left off, next step, blockers"; next agent resumes from ~200 tokens | Tokens, Fast |
| E3 | Code map | Per code file: functions, classes, what calls what, one-line purpose; refreshed by hash. Agents look up code instead of reading it | Tokens |
| E4 | Task briefs for subagents | Brain assembles a tailored brief (relevant decisions, files, past outcomes, rules) when a task is handed to a subagent | Tokens, Effective |
| E5 | Dedupe on write | Before saving, check for a near-identical memory; update/merge instead of adding a copy | Memory mgmt, Efficient |
| E6 | Secrets guard | Block API keys, passwords, tokens from ever being stored; mark sensitive rows | Safety |

**Tier 2: sharpen quality**

| # | Enhancement | What it does | Goal |
|---|---|---|---|
| E7 | Use-based ranking & decay | Track how often a memory is used and if it helped; useful ones rise, unused ones fade and get archived | Effective, Memory mgmt |
| E8 | Token-budgeted answers | Agent asks "best 800 tokens on X"; brain packs the most relevant rows to fit | Tokens |
| E9 | Time-aware facts | Facts/decisions carry valid-from / valid-to; superseded ones stay as history, never confused with current | Effective |
| E10 | Lessons register | Failures and mistakes from outcomes become "don't do X because Y" rules shown at boot | Effective |
| E11 | Local embeddings | Meaning-search vectors made by a small model on this PC: free, private, no network | Fast, Efficient |
| E12 | Brain health score | Dashboard metric: stale %, conflicts, orphans, unused memories, last audit | Memory mgmt |

**From claude-obsidian (accepted 2026-11-12, D14)**

| # | Enhancement | What it does | Goal |
|---|---|---|---|
| E16 | Single writer + safe transactions | Agents never write directly; they send changes to one brain service that checks fingerprints, applies all-or-nothing, keeps a rollback journal, and stops on conflict. Also fits SQLite's one-writer-at-a-time limit | Memory mgmt, Effective |

**Tier 3: later (deferred until the brain is running; E15 promoted by D10)**

| # | Enhancement | What it does |
|---|---|---|
| E13 | Markdown snapshot export | Readable, git-versioned copy of the brain for backup and human browsing |
| E14 | Ask-the-brain box | Natural-language questions to the brain from the dashboard |
| E15 | Visual graph explorer | Interactive map of how decisions, files and tasks connect (like AIS-OS 3D brain) |

## Dependencies on other functions

- None yet. (Likely: every future function will read/write Memory.)

## Open questions

- [x] Q1 — Scope → one brain, all projects, shelf per project + global shelf (D2).
- [x] Q2 — "Tables and graphs" → both: graph structure (`links` table) + dashboard charts (D1).
- [x] Q3 — Write rules → trust levels (D3).
- [x] Q4 — File contents → summary + pointer + content hash, never full copies (D1, idea A1).
- [x] Q5 — Where it runs → local SQLite (D4).
- [x] Q6 — AI tools → any: users sign in to their own CLI subscriptions + custom API providers (D5).
- [x] Q7 — Code map languages → Claude's recommendation adopted (D6).
- [x] Q8 — Token budget → ~800 tokens default, revisit after tests (D7).
- [x] Q9 — Where the brain lives → on the user's own PC, never uploaded (D8).
- [x] Q10 — Personal or shared → personal for now, team sharing possible later (D9).

*Q1–Q10 closed as of 2026-11-12. New GUI questions:*

- [x] Q11 — GUI form → both: built-in GUI + optional Obsidian export (D11).
- [x] Q12 — Editing → users can edit (D12).
- [x] Q13 — Launch views → Claude's suggestion (D13).
- [x] Q14 — E16 → accepted (D14).

*All open questions closed as of 2026-11-12.*

## Decisions made

- Memory is the first function of the system.
- Storage is a self-owned database, shared by all agents and subagents.
- 2026-11-12 — Enhancements E1–E12 (Tier 1 + Tier 2) accepted into scope. E13–E15 deferred.
- **D1 (2026-11-12) — Hybrid design.** Database is the source of truth; readable views/dashboard for the user; AIS-OS rules (route don't copy, raw vs confirmed, decision log, archive not delete). The "Proposed design" section above is now the agreed baseline.
- **D2 (2026-11-12) — One brain, many shelves.** Single brain for all projects; one shelf per project + one global shelf (preferences, style, lessons). Agents load only current project shelf + global. Start with The Insectoids shelf only.
- **D3 (2026-11-12) — Trust levels for writing.**
  - Updates, work done, task status, agent's own notes, outcomes → agents write automatically.
  - Facts → agents write as *unconfirmed* with confidence; confirmed by user or repeated evidence.
  - Decisions → agents only *propose*; user approves.
  - Never delete (archive). Never silently overwrite (new version). Conflicts flagged for the user, not auto-resolved.
- **D4 (2026-11-12) — Runs locally.** One SQLite file at `D:\Brain\brain.db`, outside any project folder; automatic daily backup to another drive or cloud folder. Tables designed so a later move to PostgreSQL (many parallel writers / remote access) is easy.
  - *Amended by D8:* brain location is a per-user setting (default: the AIOS app's data folder), not hard-coded to `D:\Brain`. Backups go to a local location only (e.g. another drive), not a cloud folder.
- **D5 (2026-11-12) — Tool-agnostic brain.** The AIOS lets users sign in to their own AI subscriptions (Claude Code, Codex, Gemini CLI, Cursor, Copilot, Qwen, OpenCode, etc.) and add custom API providers (OpenRouter, FreeLLMAPI, Ollama/local, any OpenAI-compatible endpoint). Therefore the brain must not depend on any one tool:
  - **Three doors into the brain:** an MCP server (most AI CLIs support MCP), a `brain` command-line tool (for tools without MCP), and a local HTTP API (for API-based agents and the dashboard).
  - **Load/save done by the AIOS harness itself**, not only by tool hooks: the harness injects the boot card when it starts an agent and captures the handoff when it stops one. Tool-native hooks (e.g. Claude Code) are an extra, not a requirement.
  - **Model-neutral content:** memories stored as plain text + structured fields; no provider-specific formats.
  - **Embeddings always local (E11)**, so search works the same whatever model or provider the user picks, and costs nothing.
- **D6 (2026-11-12) — Code map languages (Claude's pick, delegated by user).** Use a universal parser (tree-sitter) with one plug-in per language.
  - **At launch:** TypeScript/JavaScript and Python (most common for AI tooling and web apps), plus structure-only maps for Markdown, JSON, YAML and SQL.
  - **Added on demand:** Go, Rust, Java, C#, PHP, etc. when a user's project contains them.
  - Unknown languages fall back to file-level summaries (no function list).
- **D7 (2026-11-12) — Default answer budget ~800 tokens.** Agents may request more. To be tuned after real tests.
  - *Proposed extra:* cap the budget lower for small-context models (common on free tiers), e.g. never more than ~5% of the model's context window.
- **D8 (2026-11-12) — Brain stays on the user's PC, never uploaded.**
  - Each user's brain is stored locally on their own computer; the AIOS never uploads it or syncs it to any server.
  - Location is a per-user setting (default: the app's data folder). Backups are local only (another drive/folder the user picks).
  - No brain content in telemetry or logs sent anywhere.
  - Honest limit: when an agent *reads* a memory, that text goes to whichever AI provider the agent uses, as part of its prompt. Only local models (Ollama, LM Studio, vLLM) keep it fully on the PC. The secrets guard (E6) keeps keys/passwords out of this path entirely.
- **D9 (2026-11-12) — Personal brain for now.** One brain per user. To allow a later upgrade to team sharing, every record already carries `owner` and `shelf` fields, so a "team shelf" can be added without redesign.
- **D10 (2026-11-12) — The brain has its own GUI.** A visual interface like the AIS-OS globe or Obsidian's graph view, for browsing and managing the brain. E15 (visual graph explorer) moves from deferred into scope.
- **D11 (2026-11-12) — GUI form: both.**
  - **Main:** a built-in Brain GUI inside the AIOS app, reading the database directly. No extra install for users.
  - **Optional:** a read-only export of the brain as an Obsidian vault (Markdown + links), for users who like Obsidian's graph/Canvas. This promotes E13 (Markdown snapshot) into scope. Edits made in Obsidian do not flow back (avoids conflicts); two-way sync can be considered later.
- **D12 (2026-11-12) — Users can edit memories in the GUI.** Every edit goes through the single writer (D14): saved as a new version, history kept, nothing lost. User edits count as *confirmed* (D3). If an agent changed the same item meanwhile, the GUI shows the conflict instead of overwriting.
- **D13 (2026-11-12) — Views, in two phases.**
  - **Phase 1 (launch):** Graph (Obsidian-style, colored by type, filters by project/type/date) · Tables (decisions, tasks incl. kanban, files, facts) · Reader (item + links, backlinks, version history) · Approval inbox (decisions to approve, facts to confirm, conflicts) · Search (keyword + meaning).
  - **Phase 2:** Globe (3D, AIS-OS style) · Dashboard (progress charts, health score E12, tokens saved) · Timeline (what happened, when, by which agent).
  - Later: Ask-the-brain box (E14).
- **D14 (2026-11-12) — Single writer with safe transactions (E16).** Agents and the GUI never write to the database directly; they submit changes to one brain service, which checks fingerprints, applies all-or-nothing, keeps a rollback journal, and stops on conflict.

## Change log

- 2026-11-12 — Created from the user's first description.
- 2026-11-12 — Added AIS-OS brain as reference design.
- 2026-11-12 — Added Ruflo brain as reference design and comparison table.
- 2026-11-12 — Added user's five goals, best ideas to adopt, and draft design.
- 2026-11-12 — Added 15 enhancement candidates (E1–E15), not yet accepted.
- 2026-11-12 — User accepted Tier 1 + Tier 2 (E1–E12); Tier 3 deferred.
- 2026-11-12 — User approved D1–D4; Q1–Q5 closed; Q6–Q8 opened.
- 2026-11-12 — Q6–Q8 answered → D5 (tool-agnostic), D6 (code map languages), D7 (800-token budget). Added Munder Difflin and FreeLLMAPI references. Opened Q9–Q10; proposed D4 amendment.
- 2026-11-12 — Q9–Q10 answered → D8 (local only, never uploaded; D4 amended), D9 (personal, team-ready fields). All questions closed.
- 2026-11-12 — User added GUI requirement → D10; E15 promoted. Added claude-obsidian reference and E16 candidate. Opened Q11–Q14.
- 2026-11-12 — Q11–Q14 answered → D11 (built-in GUI + Obsidian export; E13 promoted), D12 (editable), D13 (two-phase views), D14 (E16 accepted). All questions closed.
- 2026-11-12 — **Finalized by user.** Further changes go through a new change-log entry.
