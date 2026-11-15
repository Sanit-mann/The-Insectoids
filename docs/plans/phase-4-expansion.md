# Phase 4 "Expansion": Implementation Plan

**Branch:** `phase-4-expansion` · **Started:** 2026-11-15 · **Spec:** [functions/10-build-roadmap.md](../../functions/10-build-roadmap.md) (Phase 4), [functions/04-connections.md](../../functions/04-connections.md), [functions/06-workspace-safety.md](../../functions/06-workspace-safety.md), [functions/01-memory.md](../../functions/01-memory.md)

**Goal:** the hive reaches further and stays safe while it does. In the Phase 4 demo:
1. The user asks the Brain a question in plain words and gets an answer that cites the records it came from; the Brain Globe shows the same records in 3D.
2. A goal reads the user's calendar and recent mail (through the OAuth broker; nothing sent without approval) and plans around them.
3. A risky card (one that runs untrusted code) runs inside a container, chosen by the Watchdog, while normal cards run as before.
4. A card runs on a second subscription engine beyond Claude Code and OpenCode.

Like Phases 1–3, every step ends in something that works and is tested, and core services are built test-first. Every outside action still goes through Connections and approvals (04-D4, 02-D7).

## Starting point (2026-11-15)

- **Already there (v0.0.3):**
  - Engines: Claude Code and OpenCode (local models or API providers); Gemini CLI built but on hold; Codex listed but not built.
  - Services through the Vault and secret broker: GitHub, Brave Search, Notion, Linear, Slack built in, Jira and custom REST services as templates (04-D5 phase 2 is done).
  - Brain views: reader, graph, dashboard (with a timeline section), code map, meaning search, Obsidian export.
  - Safety: worktree per card, command guard, protected paths, network rules by caste. No container mode.
- **On this computer:** Claude Code 2.1, OpenCode 2.2.6, Gemini CLI 0.68 and a `copilot` command are installed. Docker, Podman, Codex and the Cursor agent are not.

## Steps

### Milestone A: The Brain, seen and asked

| Step | What | Where | Done when |
|---|---|---|---|
| A1 | **Ask the Brain:** a box on the Brain screen. Plain-words question → meaning + keyword search → a short answer that cites the records it used (links open them). Small model by default (the Treasurer routes it; local model when available), with the cost shown before the first question and in the answer. Answers can be saved as a note (unconfirmed) | `harness`, `desktop` | Unit tests: retrieval picks the right records, citations point at real records, no answer without sources ("The Brain doesn't know"); e2e with the scripted engine |
| A2 | **Brain Globe** (01-D13 phase 2, the user asked for it): records as points on a 3D sphere, coloured and shaped by kind, links as arcs; rotate, zoom, filter by shelf/kind/time; click opens the record. A list view next to it carries the same content for keyboard and screen-reader users. Runs smoothly with ~5,000 records | `desktop` | e2e: the globe renders the seeded Brain, filters change it, clicking a point opens the record; axe passes; a frame-time check on a large Brain |
| A3 | **Timeline view:** the dashboard's timeline becomes its own view: what happened, when, by which agent, filterable, with a jump to the record or goal | `desktop` | e2e: filters and jumps work |

### Milestone B: More engines

| Step | What | Where | Done when |
|---|---|---|---|
| B1 | **A generic "command" engine** (04-D2 "custom command"): any CLI that takes a prompt and edits files in the worktree, with the hive tools over MCP when it supports them, otherwise the guarded file and shell tools. This is the base the next engines build on | `harness` | Contract tests with a scripted CLI |
| B2 | **GitHub Copilot CLI** adapter: install text, sign-in in its own login, models by tier, how the guard protects its runs, usage reporting | `harness`, `desktop` | Unit tests; a real smoke test with the user's consent |
| B3 | **Codex** and **Cursor agent** adapters (only if the user has those subscriptions; otherwise listed with real install text, as Codex is today) | `harness`, `desktop` | Unit tests; real smoke tests when available |
| B4 | **The rest** as presets on the generic engine (Qwen, Grok, Kimi, Crush, Pi, Antigravity), each marked "untested" until someone runs it | `harness` | Each preset's command line checked by tests |

### Milestone C: OAuth services

| Step | What | Where | Done when |
|---|---|---|---|
| C1 | **OAuth broker** (04 draft item 8): the app's own sign-in flow with PKCE on a loopback address, tokens kept in the Vault and refreshed by the broker; agents never see a token (same broker rules as keys, 04-D4). Per-service consent tiers: read on, write/send off until the user says yes | `desktop` | Unit tests against a fake OAuth server: sign-in, refresh, revoke, expired refresh, a token never reaching a card |
| C2 | **Google Calendar:** read events, find free time; creating events waits for approval | `desktop`, MCP tools | e2e against a fake Google API |
| C3 | **Gmail:** search and read mail, draft replies; sending always waits for approval | `desktop`, MCP tools | e2e against a fake Google API; a real read-only check with the user's account and consent |
| C4 | **Service events** (deferred from Phase 3): a new GitHub issue or PR, or a new mail matching a filter, can start a cadence (05-D2) | `desktop` | e2e with the fake APIs |

### Milestone D: Container sandbox

| Step | What | Where | Done when |
|---|---|---|---|
| D1 | **Container mode** (06-D4): a card can run inside a Docker or Podman container with only its worktree mounted, the network rules of its caste, and limits on CPU, memory and time. Detected, never installed silently | `workspace`, `harness` | Tests with a fake runtime; a real run when a runtime is installed |
| D2 | **Who chooses:** the Queen marks risky cards (running untrusted code, installing packages), the Watchdog can move a struggling card into a container, and the user can force it per goal. Status in words on the card and the Hive screen | `harness`, `desktop` | e2e with the fake runtime |

### Milestone E: Release

| Step | What | Where | Done when |
|---|---|---|---|
| E1 | **Phase 4 demo** (the goal at the top), real engines with consent and a cost estimate first | — | All four parts pass end to end |
| E2 | **Release v0.0.4**, then merge into main, as before | CI | Draft release checked and published by the user |

## Decisions for the user

Decided 2026-11-15:

1. **Engines:** GitHub Copilot is built and tested (its command is installed here). Codex and the Cursor agent stay "listed, not available" until there is a subscription to test against; B3 shrinks to that, and the generic engine (B1) and presets (B4) still come.
2. **Google sign-in: yes.** The user creates the Google Cloud project and OAuth client when C1 starts, with step-by-step guidance. Testing mode (only the user signs in; tokens last 7 days) is fine for personal use. The app never handles the user's Google password; the client secret, if any, goes into the Vault by the user.
3. **Containers: a fake runtime for now.** D1–D2 are built and tested against a fake Docker/Podman runtime; real container runs wait until the user installs one.
4. **The Globe uses Three.js**, pinned and at least 14 days old (asked again with the exact version and size before installing).
5. **Order:** A (Brain) → B (engines) → C (OAuth) → D (containers) → E, one step at a time on the user's yes.

## Not in Phase 4 (by design)

- Voice input, the phone companion, team shelves, and batch rewriting of the dormant library (roadmap "Later").

## Progress

- **Started 2026-11-15:** branch `phase-4-expansion` created from `main` at v0.0.3 (`80fa5c6`). This plan was written from the roadmap and the Connections, Workspace & Safety and Memory specs.
