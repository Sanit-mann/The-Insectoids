# 07 — The App (Shell & UI)

**Status:** Finalized (2026-11-12)
**Created:** 2026-11-12
**Last updated:** 2026-11-12

---

## Purpose

Bring every screen the earlier functions asked for into **one desktop app** the user actually lives in: talking to the Queen, approving things, watching the hive, browsing the Brain, and managing connections, schedules and the library.

## Screens already required by earlier decisions

| Screen | What it does | Required by |
|---|---|---|
| **Queen chat** | The user's one conversation with the hive: goals, plans, reports, questions | 02-D4, 02-D5 |
| **Approval inbox** | Plans to approve, decisions to confirm, facts to confirm, conflicts, risky actions, merges to main | 01-D3, 01-D13, 02-D7, 05-D6, 06-D3 |
| **Taskboard** | Cards by wave and status (kanban) | 02-D10, 01-D13 |
| **Hive monitor** | Every agent: role, task, model + effort, tokens and cost, status, live output; Watchdog alerts | 02-D9 P2, 02-D12 |
| **Brain** | Graph, tables, reader, search (phase 1); globe, dashboard, timeline (phase 2) | 01-D10–D13 |
| **Changes & undo** | What each card/wave/goal changed (diffs), undo, approve merge to main | 06-D3, 06-D6 |
| **Library** | Catalog of agents, skills and tools; active vs dormant; approve new or imported skills | 03-D5, 03-D6, 03-D8 |
| **Connections** | Engines (install, sign-in, health), API providers, services, vault, consent tiers, usage and limits | 04-D2–D7 |
| **Cadence** | Schedules and triggers, trust per trigger, trigger log, maintenance jobs, the "while you were away" digest | 05-D2–D8 |
| **Budgets & usage** | Token and cost budgets per goal, cadence, agent and subscription | 02-D7, 02-D9, 04-D7 |
| **Settings** | Limits, protected paths, Brain location and backups, theme, notifications | 01-D8, 06-D8 |
| **Onboarding** | First-run setup (function 08) | — |

## Reference: how others present it

- **Munder Difflin:**
  - a 2D pixel-art office where agents walk between desks and messages fly as envelopes;
  - click a desk to see that agent's live terminal and type into it;
  - a sidebar with a status line per agent and an "Asked you" flag;
  - a Command Center with kanban, fleet monitor and activity log;
  - an optional TV-show office theme.
- **Ruflo:** a console "agent cockpit" with overview, swarm view, missions, logs, replay and compare of runs.
- **claude-obsidian / AIS-OS:** knowledge as a graph (Obsidian graph view, 3D globe).

## User's design-library preference (from the user's global instructions)

When this UI is built, use these libraries first instead of hand-rolled components and animations, and note which library each piece came from: Eldora UI, Skiper UI, Kokonut UI, Cult UI, Animata, Craftwork (assets), Spline (3D), Lenis (smooth scrolling). mesh3d.gallery is for inspiration only.

## Draft: main layout (proposed)

```
┌────────┬──────────────────────────────────────┬──────────────┐
│  Nav   │                                      │  Approvals   │
│ Queen  │        Main area                     │  (count)     │
│ Board  │   (Queen chat by default; other      │  Live hive   │
│ Hive   │    screens open here)                │  mini-status │
│ Brain  │                                      │  Budget bar  │
│ Library│                                      │              │
│ Connect│                                      │              │
│ Cadence│                                      │              │
│ Changes│                                      │              │
│ ⚙      │                                      │              │
└────────┴──────────────────────────────────────┴──────────────┘
```

## UI design (D9, designed by Claude at the user's request)

**Prototype:** clickable canvas with 8 screens: https://claude.ai/artifact/PBLNDomJBjC4un9ed7Meci (private to the user until shared). Source copy: [design/prototype/](../design/prototype/).

### Principles
1. **One voice, one front door.** The Queen chat is home; everything else is one click away in the left rail.
2. **Never bury a decision.** Approvals have a count in the rail, a list in the right panel, inline cards in chat, and their own inbox. Destructive approvals use hold-to-approve.
3. **Show the truth.** Show the model and effort that actually ran, real token usage, and real status. Status is always colour **plus** a text label.
4. **Calm by default.** Motion only for state changes. The living hive is the one animated view, and it pauses when hidden. Reduced-motion is respected.
5. **Progressive detail.** Summaries first; detail in side panels; raw output (terminals, diffs) only on demand. This is the UI version of the Brain's tiered reading.
6. **Undo is always visible** where changes are shown.

### Shell
- **Left rail:** Queen · Approvals (count) · Taskboard · Hive · Brain · Changes · Library · Connections · Cadence · Settings.
- **Top bar:** goal switcher, Ctrl K command palette, background-work pill ("Wave 2 of 3 · 4 insects working"), theme toggle.
- **Right panel (on the Queen screen):** approvals, hive-now list, budget bars (goal and each subscription's limit window), "while you were away" digest.
- **Responsive:** the rail, main area and right panel wrap and stack on narrow windows.
- **Tray (D7):** status icon (hive working / idle / needs you), approvals count, Pause hive, Open.

### Screens (prototyped)
| Screen | Design |
|---|---|
| Queen chat | Thread with plan cards (waves, card counts, estimate, approvals needed, Approve / Adjust), progress cards with mini agent lanes, inline "Needs you" cards; composer with model + effort chip, attach, voice (disabled until later), context meter |
| Approval inbox | Filter chips by kind (plans, risky actions, merges, decisions, facts, schedules); list + detail with "why it needs you" and "if you say yes"; Approve / Deny / Ask the Queen |
| Taskboard | Kanban: Open, In progress, Blocked, Review, Done; wave switcher; card detail with brief, acceptance, dependencies, holder, lease, model, attempts |
| Hive monitor | **Lanes** table (agent, task, model + effort, tokens, status) and **Living hive** honeycomb view; selected agent shows live read-only output, Take over / Hand back, Watchdog breaker ladder; Pause hive |
| Brain | Graph (records as shaped, coloured nodes; edges only from real links), search by words or meaning, legend; reader with trust, source, links, versions, Edit / Archive; phase-2 views shown as "later" |
| Changes & undo | Goal → wave → card tree; diff viewer; Undo card / wave / goal; Approve merge into main |
| Connections | Tabs: Engines (sign-in state, models, effort, limit windows, one-click install showing the exact command), API providers, Services (consent tiers and phases), Vault |
| Design system | Tokens, status colours, type, shape and motion rules, full component map with source library |

### Screens not prototyped (same patterns)
- **Library:** catalog table (active, dormant, draft) with filters by caste, kind and status; item reader; Approve proposed or imported skill; Activate / Retire; success rate and cost per item.
- **Cadence:** list of schedules and triggers (next run, trust level, budget, autonomy); trigger log; maintenance jobs with on/off; digest view.
- **Budgets:** goal, cadence, agent and subscription budgets with charts; Treasurer routing history.
- **Settings:** limits (insect cap, budgets), protected paths, Brain location and backup folder, theme, language, notifications, keep-awake.

### States every screen handles
Empty (an empty state that becomes the first item), loading (skeletons, never spinners for whole screens), error (an inline alert that can re-run the failed check), offline engine (engine card shows a fix action), and "waiting for you" (sky status + approvals count).

### Accessibility (WCAG 2.2 AA)
- Text contrast ≥ 4.5:1 (colours chosen to pass on both themes).
- Status is never colour-only.
- Full keyboard use: Ctrl K, visible focus ring, and arrow keys within lists, kanban and the honeycomb.
- Live agent updates are announced in a throttled way, not every token.
- Touch targets ≥ 40 px.
- Reduced motion honoured.

### Visual tokens
- **Dark ground:** `#0F0E0B` / surface `#17150F` / line `#2A261E` / text `#F1EBDD` / muted `#A8A08F` / honey `#F2A93B`.
- **Light ground:** `#FAF7F0` / surface `#FFFFFF` / text `#1C1912` / muted `#6B6354` / honey text `#8F5600`.
- **Status:** working `#F2A93B`, waiting `#6CB6F5`, blocked `#EF7A5E`, done `#86C98A`, paused `#B49CF0`, idle `#6E675A`.
- **Type:** Space Grotesk (titles), Inter (UI), JetBrains Mono (code).
- **Icons:** Lucide.

### Component map (summary; full table on the Design system screen)
- **Kokonut UI:**
  - `ai-prompt`, `ai-context-meter`, `ai-message-queue`
  - `ai-tool-approval`, `hold-button`
  - `ai-agent-lanes`, `ai-loading`, `ai-tool-calls`
  - `action-search-bar`, `status-island`
  - `ai-diff-review`, `undo-button`
  - `ai-memory`, `ai-connect`, `ai-model-selector`
  - `metric-card`, `promise-toast`, `notification-stack`, `inline-alert`
  - `empty-state`, `stack-panel`, `switch-button`, `ai-voice`
- **Cult UI:**
  - `kanban-board`, `side-panel`, `family-drawer`
  - `halo-*` form controls
  - `analytics-chart`, `rolling-number`, `code-block`
  - `onboarding`, `wizard-expandable`, `globe`
- **Eldora UI:** `terminal` (look), `cobe-globe`.
- **Skiper UI:** `skiper4` (theme toggle), `skiper37` (animated number), `skiper101` (tooltip).
- **Custom (no match in the preferred libraries):** the living-hive honeycomb and the Brain graph.
- **Lenis:** only if a long-scroll view needs it; the app is mostly panels.
- **Spline:** reserved for an optional 3D Brain globe in phase 2.
- **Setup:** registries are configured in the project's `components.json` (created 2026-11-12).

## Inputs / Outputs

- **Inputs:** everything the Brain, Hive, Connections, Cadence and Workspace expose.
- **Outputs:** the user's goals, answers, approvals, edits and settings.

## Dependencies on other functions

All of 01–06; it is the one place they meet the user. Tech choice (Electron, Tauri, etc.) belongs to the tech-stack step, not here.

## Open questions

- [x] Q1–Q7 — Delegated by the user to Claude ("you think, engineer, plan and design UI") → D2–D8, plus the full UI design (D9).

*All questions closed as of 2026-11-12.*

## Decisions made

- **D1 (2026-11-12) — The app is function 07**: one desktop app holding every screen required by functions 01–06, built with the user's preferred UI libraries.
- **D2 (2026-11-12) — Platform:** desktop first (Windows, macOS, Linux). A phone companion for the digest and approvals comes later.
- **D3 (2026-11-12) — Home is chat-first:** the Queen chat fills the main area; the visual "living hive" lives inside the Hive monitor.
- **D4 (2026-11-12) — Look and feel: subtle, professional hive theme** (hexagon motifs, amber accents on dark/neutral surfaces), plus one animated "living hive" view where agents are moving nodes.
- **D5 (2026-11-12) — Live terminals:** the user can watch any insect's live output (read-only by default) and take over; taking over pauses that insect's card.
- **D6 (2026-11-12) — Voice later,** with local speech-to-text so the user's voice never leaves the PC (01-D8).
- **D7 (2026-11-12) — Background running:** closing the window keeps the hive working from the system tray; the tray icon shows hive status and pending approvals (needed by 05).
- **D8 (2026-11-12) — Dark and light themes; English first,** with all UI text externalised so other languages can be added later.
- **D9 (2026-11-12) — UI design as documented in "UI design" above,** with the 8-screen clickable prototype and the component map. Consequence for the tech-stack step: the UI layer is React + Tailwind + shadcn-style registries, since all the preferred libraries are built on them.

## Change log

- 2026-11-12 — Created: screen inventory from 01–06, references, design-library preference, draft layout and questions.
- 2026-11-12 — User delegated all UI decisions to Claude → D2–D9; UI design written; 8-screen prototype published; components.json with the four registries added to the project root.
- 2026-11-12 — **Finalized by user.** Further changes go through a new change-log entry.
