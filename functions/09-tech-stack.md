# 09 — Tech Stack & Architecture

**Status:** Finalized (2026-11-12)
**Created:** 2026-11-12
**Last updated:** 2026-11-12

---

## Purpose

Choose the languages, frameworks and libraries, and define how the parts of the AIOS (Brain, Hive harness, broker, scheduler, UI) are split into processes and talk to each other, so functions 01–08 can be built.

## Constraints already fixed by earlier decisions

| Constraint | From |
|---|---|
| Desktop app for Windows, macOS, Linux; runs from the tray | 07-D2, 07-D7 |
| UI in React + Tailwind + shadcn-style registries (Kokonut, Cult, Eldora, Skiper) | 07-D9 |
| AI engines run as real terminal processes (CLIs) on the user's subscriptions | 04-D2 |
| Brain = local SQLite, one safe writer, keyword + meaning search, local embeddings | 01-D1, D4, D14, E11 |
| Three doors into the Brain: MCP server, `brain` CLI, local HTTP API | 01-D5 |
| OS-encrypted vault, fail closed; loopback secret broker with per-task tokens | 04-D4 |
| Code map with a universal parser (TS/JS, Python first) | 01-D6 |
| Git worktree per card; single committer; command guard; protected paths | 06 |
| Nothing uploaded; no telemetry | 01-D8 |

## Proposed stack

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | **Electron + TypeScript** | Proven for exactly this (Munder Difflin): real terminals via `node-pty`, `safeStorage` for the vault, tray, `utilityProcess` for background services. One language end to end. Tauri is lighter but would need Rust plus separate PTY and keychain work |
| UI | **React + Vite + Tailwind + shadcn registries**, Motion for animation | Required by the chosen UI libraries (07-D9) |
| Terminals | `node-pty` + `xterm.js` | Live insect output and "take over" (07-D5) |
| Brain database | **SQLite via `better-sqlite3`**, WAL mode | Fast, synchronous, single file; WAL allows many readers alongside the one writer |
| Keyword search | SQLite **FTS5** | Built in, no extra service |
| Meaning search | **`sqlite-vec`** extension | Vectors live in the same Brain file |
| Local embeddings | **transformers.js** (ONNX) with a small embedding model (~25–90 MB, downloaded once) | Free, private, works offline (01-E11) |
| Brain service | Its own Electron `utilityProcess`; it is the **only** process that writes the database | Single writer (01-D14) |
| Brain doors | MCP server (official TypeScript MCP SDK, stdio) · `brain` CLI (Node) · local HTTP API on 127.0.0.1 with a per-session token | 01-D5 |
| Code map | **`web-tree-sitter`** (WASM grammars) | No native builds; one grammar per language (01-D6) |
| Harness (Hive runtime) | Main-process module that spawns engine CLIs in PTYs, injects briefs, captures handoffs, runs status bridges, leases and heartbeats | 02, 04-D2 |
| Managers' reflexes | Plain TypeScript modules (lease timer, budget caps, loop detector, command guard) | 02-D8 |
| Secret broker | Loopback HTTP proxy in the main process; Electron `safeStorage` vault | 04-D4 |
| Git and workspaces | `git` CLI (worktrees, branches, merges) driven only by the harness | 06-D2, 06-D3 |
| Containers (optional) | Docker or Podman when installed | 06-D4 |
| Scheduler | In-process scheduler + OS power events (catch up once on wake) | 05-D5 |
| File watching | `chokidar` | 05-D2 |
| Brain graph view | **Sigma.js + graphology** (WebGL, handles large graphs) | 01-D13 |
| Packaging | `electron-builder` installers; code signing on Windows and macOS | — |
| Monorepo | **pnpm workspaces** | Shared types across processes |
| Tests | **Vitest** (unit), **Playwright** (end-to-end in Electron) | — |

## Architecture

```
┌──────────────────────────── Electron app ─────────────────────────────┐
│  Renderer (React UI) ── typed IPC bridge (no Node access) ──┐         │
│                                                             ▼         │
│  Main process                                                         │
│   ├─ Harness: spawns engine CLIs in PTYs · briefs · handoffs · leases │
│   ├─ Manager reflexes: Foreman · Treasurer · Watchdog (command guard) │
│   ├─ Secret broker (127.0.0.1) + vault (OS-encrypted)                 │
│   ├─ Git / workspace manager (single committer, worktrees, undo)      │
│   ├─ Scheduler + file watcher + webhook listener (Cadence)            │
│   └─ Tray                                                             │
│                                                                       │
│  utilityProcess: Brain service  ── the ONLY writer ──▶ brain.db       │
│     FTS5 · sqlite-vec · embeddings (transformers.js) · code map       │
│     doors: MCP (stdio) · brain CLI · HTTP API (127.0.0.1 + token)     │
└───────────────────────────────────────────────────────────────────────┘
        ▲ PTY             ▲ MCP / CLI / HTTP              ▲ HTTPS via broker
 ┌──────┴──────┐   ┌──────┴───────────┐           ┌───────┴────────┐
 │ Engine CLIs │──▶│ Brain (read/write│           │ Outside APIs   │
 │ Claude Code,│   │ through service) │           │ GitHub, etc.   │
 │ Codex, …    │   └──────────────────┘           └────────────────┘
 └─────────────┘
```

## Repository layout (proposed)

```
The Insectoids/
  apps/desktop/          Electron main, preload, renderer (React)
  packages/brain/        Brain service: schema, writer, search, embeddings, code map
  packages/brain-mcp/    MCP server door
  packages/brain-cli/    `brain` command
  packages/harness/      engine adapters, PTY, briefs, handoffs, leases, bridges
  packages/reflexes/     Foreman, Treasurer, Watchdog code reflexes, command guard
  packages/broker/       secret broker + vault access
  packages/workspace/    git worktrees, merges, checkpoints, undo
  packages/cadence/      scheduler, watchers, webhooks
  packages/shared/       types and contracts used by every process
  library/               agents, skills, tools, catalog (already built)
  functions/  design/    specs and prototype (already written)
```

## Honest limits to plan around

- **Command guard coverage depends on the engine.** Claude Code and Codex expose pre-action hooks the guard can use. For an engine without hooks, the guard cannot inspect each command, so such engines must run in container mode or with stricter approvals.
- **Electron is heavier** than a native or Tauri app: more memory and a bigger installer. This is accepted for proven terminals and keychain support.
- **Native modules** (`node-pty`, `better-sqlite3`) must be rebuilt for each Electron version and platform in CI.
- **Subscription usage numbers** (04-D7) are only as good as what each engine reports. Some limits will be estimated from transcripts.

## Dependencies on other functions

Implements 01–08. The build order is set in function 10 (roadmap).

## Open questions

- [x] Q1 — Desktop shell → Electron (D2).
- [x] Q2 — Licence → open source, MIT (D3).

*All questions closed as of 2026-11-12.*
- [x] Q3 — Updates → D4.
- [x] Q4 — Engines without hooks → D5.
- [x] Q5 — Embedding model download → D6.
- [x] Q6 — Repository → D7.

## Decisions made

- **D1 (2026-11-12) — Tech stack & architecture is function 09.**
- **D2 (2026-11-12) — Electron + TypeScript** desktop shell. The "Proposed stack" table and the architecture above are adopted as the baseline.
- **D3 (2026-11-12) — Licence: open source, MIT** (decided by the user). A `LICENSE` file is at the project root. Compatible with the adapted library sources (MIT and Apache-2.0); their notices stay in `library/THIRD-PARTY-NOTICES.md` and `library/licenses/`. Any dependency added later must have a licence compatible with MIT distribution (the Librarian/Reviewer check this). Making the repository public is a separate step the user does when ready.
- **D4 (2026-11-12) — Updates:** the app checks online for new versions (download only; nothing about the user is sent), with an off switch in Settings and a "restart to update" prompt. Updates are never forced.
- **D5 (2026-11-12) — Engines without pre-action hooks** run only in container mode, or with every command needing approval, until they support hooks the command guard can use.
- **D6 (2026-11-12) — Embedding model** (~25–90 MB) is downloaded during setup, with its size shown first.
- **D7 (2026-11-12) — Build here:** the app is built in `D:\The Insectoids` as a pnpm monorepo next to `functions/`, `design/` and `library/`, using the repository layout above.

## Change log

- 2026-11-12 — Created: constraints from 01–08, proposed stack, architecture, repo layout, limits and questions.
- 2026-11-12 — User accepted Claude's suggestions → D2, D4–D7; licence (Q2) deferred → D3.
- 2026-11-12 — User chose open source MIT → D3 updated; LICENSE file added.
- 2026-11-12 — **Finalized by user.** Further changes go through a new change-log entry.
