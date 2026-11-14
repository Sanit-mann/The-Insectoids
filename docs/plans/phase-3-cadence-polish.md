# Phase 3 "Cadence & Polish": Implementation Plan

**Branch:** `phase-3-cadence-polish` · **Started:** 2026-11-14 · **Spec:** [functions/10-build-roadmap.md](../../functions/10-build-roadmap.md) (Phase 3), [functions/05-cadence.md](../../functions/05-cadence.md)

**Goal:** the hive works without being asked, and the app is ready for people who don't build it from source. In the Phase 3 demo:
1. A weekly scheduled report runs while the app sits in the tray, with the window closed.
2. The next morning, the "while you were away" digest shows what ran, what it cost, and what needs the user.
3. The app installs from a downloaded installer and tells the user when a new version exists.

Like Phases 1 and 2, every step ends in something that works and is tested, and core services are built test-first. Every cadence runs as normal hive work through the Queen; nothing bypasses the hive (05-D1).

## Starting point (2026-11-14)

- **Already there:**
  - the tray, with working / idle / needs-you status and Pause / Resume (07-D7);
  - dark and light themes (07-D8);
  - one app instance at a time;
  - Cadence as a rail item with a placeholder screen.
- **Not built yet:**
  - anything time- or event-driven;
  - reacting to sleep and wake;
  - Brain backups (01-D8);
  - notifications;
  - packaging and update checks.
- **Decisions already made in the specs** (05-D1–D8, 09-D4), so they're not reopened here:
  - **Triggers:** schedules, file watch, webhooks, hive events and maintenance.
  - **Trust for outside triggers:** communication-only by default.
  - **Missed runs:** catch up once on wake.
  - **Unattended work:** a budget and autonomy level per cadence.
  - **Maintenance:** on by default.
  - **Notifications:** only for approvals and failures.
  - **Updates:** checked online and never forced.
- **Decided by Claude for Phase 3** (the user can change any of these):
  - **Webhooks listen on this computer only** (127.0.0.1). Reaching them from the internet needs a tunnel the user runs and chooses; the app never opens a port to the network by itself.
  - **The scheduler lives in the Brain host**, next to the hive, so it keeps running with the window closed. Cadences and the trigger log live in the Brain (05 deps).
- **Open for the user:** see "Decisions for the user" below.

## Steps

Three milestones, each ending in something the user can try.

### Milestone A: Cadence

| Step | What | Where | Done when |
|---|---|---|---|
| A1 | **Schedules:** a cadence = when + what + limits + how to report. Schedule types: interval and weekly ("Mon and Thu 09:00") in local time, so daylight saving never shifts them. A run becomes a goal for the Queen with the cadence's own token budget and autonomy level (05-D6). Brain migration v13 adds cadences and a trigger log. Cadence screen: list, create, edit, pause, history | `brain`, `harness`, `desktop` | Unit tests with a fake clock (DST and month-end cases); e2e: a 1-minute cadence starts a goal |
| A2 | **Sleep and wake:** missed runs collapse into one catch-up run on wake (05-D5). An optional keep-awake switch while the hive works (off by default; it costs battery) | `desktop` | Fake-clock tests for long sleeps; the switch shows its state in words |
| A3 | **File watch and hive events:** a new file in a watched folder starts a cadence (the folder must be inside a project or chosen by the user); "when a goal finishes, start the follow-up"; "when a budget crosses a threshold, report" | `harness`, `desktop` | e2e: dropping a file starts a goal; a goal's end starts its follow-up |
| A4 | **Webhooks and trust:** one local URL and secret per webhook (the secret stays in the Vault, 04-D4). Trust modes: strict, communication-only (the default) and allow-all. Every inbound call goes to the trigger log; anything asking the hive to act waits in Approvals unless the user loosened trust | `desktop` | e2e: a signed call is logged and waits for approval; a bad signature is refused and logged |
| A5 | **Maintenance and proposals:** built-in jobs, on by default (05-D7): Brain health check and audit, a daily local backup, consolidation and dedupe, stale-task cleanup, and a skill review. A required job the user deletes comes back switched off, never silently lost. The Queen proposes a cadence when she sees the same request 3+ times; the user approves it (05-D3) | `brain`, `harness`, `desktop` | A backup restores into a fresh Brain; a proposal appears after three similar goals |

### Milestone B: While you were away

| Step | What | Where | Done when |
|---|---|---|---|
| B1 | **Digest:** "while you were away" in the app: what ran unattended, what passed or failed, what it cost, and what waits for the user (05-D8). It opens on the first visit after unattended work | `harness`, `desktop` | e2e with a fake clock: overnight runs appear in the morning digest |
| B2 | **Notifications and background:** desktop notifications for approvals needed and failures only. Tray polish: the next scheduled run, "Run now", and a "start with my computer" switch (off by default) | `desktop` | Unit tests for what notifies and what stays quiet; e2e for the tray state |

### Milestone C: Release polish

| Step | What | Where | Done when |
|---|---|---|---|
| C1 | **Accessibility pass (WCAG 2.2 AA):** an automated axe check of every screen in both themes, plus keyboard-only and screen-reader passes on the main flows; fix what they find | `desktop` | axe finds no serious issues on any screen; keyboard paths covered by e2e |
| C2 | **Obsidian export** (01-D11): the Brain as a folder of Markdown notes with frontmatter and `[[links]]`, written to a folder the user picks; secrets are never written | `brain`, `desktop` | The export opens as an Obsidian vault with working links; a planted secret never appears |
| C3 | **Installers:** Windows, macOS and Linux installers built by CI from a version tag and attached to the GitHub release. Windows builds are signed through SignPath once it approves the project; until then, and on macOS, they are unsigned, and the README says how to open them | CI, `desktop` | A CI build produces all three; the Windows installer installs and starts on this PC |
| C4 | **Update checks** (09-D4): the app checks GitHub Releases for a newer version (it sends nothing about the user), shows it in Settings with an off switch, and offers "restart to update" where the platform allows it. Never forced | `desktop` | Tested against a fake release feed: newer, same and older versions |
| C5 | **Phase 3 demo** | — | A weekly report runs from the tray with the window closed, and the morning digest shows it; real engine runs need the user's consent and a cost estimate first |

## Decisions for the user

1. **Code signing: decided 2026-11-14.**
   - **Windows:** free signing through the SignPath Foundation, which signs open-source projects; the user applies. The project fits its rules: an MIT license, a public repository, CI builds, and earlier releases. The application needs two-factor sign-in on GitHub.
   - **macOS:** stays unsigned (no paid Apple Developer account).
   - **Until SignPath approves:** installers are built unsigned, so C3 doesn't wait on it.
2. **New tools (asked when each step starts):**
   - `electron-builder` to make installers (C3);
   - `@axe-core/playwright` for the accessibility check (C1);
   - possibly `electron-updater` (C4).

   Each is pinned to a release at least two weeks old, as before.
3. **Real runs** (A1–A5 use the scripted engine; only the C5 demo spends tokens): a cost estimate comes first, as in Phases 1 and 2.

## Not in Phase 3 (by design)

- Service events from GitHub, Slack or email (Phase 4, after OAuth: 04-D5).
- Phone or chat delivery of the digest (later, through Connections: 05-D8).
- Batch rewriting of the dormant library (off by default; 05-D7, 03-D9).

## Progress

- **Started 2026-11-14:** branch `phase-3-cadence-polish` created from `main` at v0.0.2. This plan was written from the roadmap and the Cadence spec.
