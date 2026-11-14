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
- **A1 Schedules: done (2026-11-14).** Built by two parallel workers (backend; Cadence screen and e2e) against a shared contract (`packages/shared/src/cadence-api.ts`). Unit tests: 950 pass, with no unhandled errors. e2e: 146 passed, 3 skipped, in two full runs. Lint and typecheck are clean. No real engine runs.
  - **What a cadence is:** a name, when (every N minutes or hours, 15 minutes at least; or weekly on chosen days at a local time), a goal for the Queen, a token budget per run, and an autonomy level. Each run goes through `submitGoal` like the user's own goals, and the goal remembers its `cadenceId`.
  - **Autonomy:**
    - **Ask me:** every plan waits.
    - **Small plans run:** the default; the hive's usual rule, where multi-wave plans wait.
    - **Run on its own:** plans start without asking.

    The user's Careful preset still wins, since the stricter rule applies. Merges, risky actions and new dependencies wait at every level. A waiting plan's approval names the cadence.
  - **Schedule logic** (`packages/harness/src/cadence/`):
    - **Local time:** weekly times use local wall-clock time, so a daylight-saving change never shifts them. A spring-forward time that doesn't exist runs at the first minute after the jump; a fall-back time that happens twice runs once.
    - **Missed runs:** any number collapse into one catch-up.
    - **Tests:** a fake clock in New York time, covering DST, month and year ends. Setting TZ at runtime works on Windows with Node 24.
  - **Scheduler** (`apps/desktop/src/brain-host/cadence-keeper.ts`, in the Brain host so it runs with the window closed): one timer for the soonest run, plus a check every 60 s.
    - **Previous run still going:** recorded as skipped (no pile-up).
    - **Paused hive:** recorded as deferred; it runs once on resume.
    - **Another project open:** that cadence waits and runs once as a catch-up when its project opens.
    - **App was closed:** the missed time runs once as a catch-up at start.
    - **Run now:** refuses with a reason while paused or busy.

    Every run gets a Queen activity line and a trigger-log entry.
  - **Storage:** Brain migration v13 adds the `cadences` and `cadence_runs` tables and `goals.cadence_id`. Deleting a cadence keeps its run history.
  - **UI:** the Cadence screen (it was a placeholder):
    - **List:** the schedule in words, the next run ("next: Mon 09:00, in 45 hours"), "Waiting to run", the autonomy, the budget, and the last run as icon plus word. Each row has an on/off switch, Run now, Runs and Edit.
    - **Form:** problems shown in words; only valid commands are sent.
    - **History panel:** links to the goal.
    - **Hold to delete.**
    - **"From cadence" marker:** on goals in Queen and Taskboard.
    - **Pieces:** Kokonut UI `empty-state`, `hold-button` and `inline-alert`; shadcn `button`; the project's own `Switch`; hand-made radio groups and day toggles.
  - **e2e:** `cadence.spec.ts` (8 tests), including a cadence that fires on its own. Under e2e only, `INSECTOIDS_E2E_CADENCE_SECONDS=1` counts interval minutes as seconds.
  - **Fix after review:** the time field said "24-hour", but Windows shows the native time picker in 12-hour form, so the label is now "Time (your local time)".
  - **Open question:** a goal that waits for merge approval still counts as running, so its cadence skips later runs until the user approves or cancels the merge. The skip line says so. This is safe (unmerged work doesn't pile up), but a weekly report would need its merge approved each week. Revisit with the digest (B1).
- **A2 Sleep and wake: done (2026-11-14).** Unit tests: 956 pass. e2e: 148 passed, 3 skipped. Lint and typecheck are clean.
  - **Wake:**
    - **The signal:** main listens for the computer waking up (Electron `powerMonitor` `resume`) and tells the Brain host (a new `wake` host call).
    - **What happens:** the scheduler checks at once instead of waiting for its next re-check. On some systems timers don't count sleep time at all, so that could be up to a minute late.
    - **Missed runs:** any that came due while asleep run once, labelled "After waking up" (a new run reason, `wake`).
    - **Tests:** a unit test with a one-minute re-check proves only the wake signal makes it run, and that waking with nothing due starts nothing. An e2e test sends a real `resume` through Electron and checks the app keeps working.
  - **Keep awake** (05-D5, off by default because it costs battery):
    - **The switch:** in Settings → "Keep awake", stored in `app.json`.
    - **What it does:** while it's on and agents are working, main holds Electron's `powerSaveBlocker` (`prevent-app-suspension`), so the computer won't go to sleep on its own; the screen can still turn off. It lets go as soon as the hive is idle, when the switch goes off, and on quit (`KeepAwake`, with unit tests and a fake blocker).
    - **Status in words:** "Off: the computer sleeps as usual", "On: the hive is idle…", or "On: keeping the computer awake now, because the hive is working". It updates live from hive changes.
    - **e2e:** the status really changes while a goal runs and again when it's done, checked against the real blocker. The choice is kept.
  - **Where it lives:** both run in main, because Electron's power APIs only exist there. The tray refresh now also updates keep-awake, and keeps working without a tray.
- **A3 File watch and hive events: done (2026-11-14).** Built by two parallel workers against a contract extension. Unit tests: 967 pass, with no unhandled errors. e2e: 152 passed, 3 skipped; the trigger spec passed 3 runs in a row. Lint and typecheck are clean.
  - **File cadences** ("When files change in a folder"): a folder inside the project, with an optional name pattern (`*.md`).
    - **Watching:** one recursive `fs.watch` per enabled file cadence of the open project, in the Brain host. It follows enable, disable, edit, delete and project switches.
    - **What counts:** files added or changed; deletions and non-matching names never trigger. `.git`, `node_modules` and the app's data folder are ignored.
    - **Settling:** changes settle for 5 s (capped under a steady stream) and become ONE run. Its goal ends with "What triggered this run:" and up to 20 file paths.
    - **The folder:** a missing folder is refused in words when saving. If it disappears later, one failed run is recorded, and watching resumes when it's back.
  - **Event cadences** ("When something happens in the hive"):
    - **A goal finishes** (after its merge decision, so a follow-up works on merged results), optionally only goals from a chosen cadence.
    - **A goal has used 75% of its budget**, once per goal: a new Treasurer `budget-warning` event, emitted with an activity line.
    - **The run is told what happened:** which goal finished and whether it merged, or the goal and its spend.
  - **Loop guard:**
    - goals started by an event cadence trigger nothing;
    - a cadence never fires on its own goals;
    - a follow-up can't follow itself, a missing cadence, or another event cadence (refused in words).
  - **Same rules as schedules:** busy runs skip, but the files or event are kept for the next run; a paused hive defers and runs once on resume; runs are one at a time. Run now works for every type ("You ran it now.").
  - **UI:**
    - **Form:** four "When" choices, the folder and pattern fields with a hint, the event choice with an "Only goals from cadence" select, and the loop-guard note. Backend errors show inline.
    - **List:** "Waits for files in inbox (*.md)" or "Waits for a goal to finish" instead of a next time.
    - **History:** "Files changed" and "Hive event".
  - **e2e:** `cadence-triggers.spec.ts`:
    - a missing folder and `../` are refused;
    - two `.md` files make one run listing both, and a `.txt` file doesn't trigger;
    - event cadence words and editing;
    - the full chain: a cadence's goal gets its plan and merge approved, then the follow-up starts.
  - **Notes:**
    - **Not checked on Linux yet:** Node's recursive `fs.watch` is implemented in JavaScript there and is heavier on big trees; CI will be its first real check.
    - **After a restart:** a pending file or event run still runs once, but the trigger details were kept in memory only, so they're lost.
    - **Merges:** a merge that changes a watched folder triggers a run. Loops can only go through merges the user approves, and busy runs skip.
- **A4 Webhooks and trust: done (2026-11-14).** I wrote the contract (`webhook-api.ts`, the `webhook` when-shape with `trust`, new outcomes and the `webhook` approval kind), then four parallel workers built main, the Brain host, the UI and the e2e spec against it. Unit tests: 999 pass, 4 skipped. e2e: 158 passed, 3 skipped; the new webhook spec passes in full. Lint and typecheck are clean.
  - **The listener** lives in main, next to the Vault: `node:http` on 127.0.0.1 only, port 47821 (`webhookPort` in app.json; e2e uses a free port). It listens only while the open project has a webhook cadence; a taken port is said in words on the Cadence screen.
    - `POST /hooks/<cadenceId>` asks the hive to run the cadence; `POST /hooks/<cadenceId>/note` only tells it something.
    - **Secret:** one per webhook, in the Vault ("Webhook secret · <name>"); app.json keeps only the cadence → Vault handle. Calls carry it as `X-Insectoids-Signature: sha256=<HMAC-SHA256 of the body>`, GitHub's `X-Hub-Signature-256`, or `Authorization: Bearer <secret>`, checked in constant time. No OS key store: no secret, so every call is refused (fail closed).
    - **Limits:** bodies up to 64 KB (413), 30 calls a minute per webhook (429), 10 s timeouts. Bodies and secrets are never logged.
    - **"Copy secret" / "New secret"** put the secret on the clipboard from main; it never reaches the renderer. A new secret stops the old one at once. Deleting the cadence removes its secret.
  - **Trust modes** (05-D4), per webhook, decided in the Brain host:
    - **Strict:** every call waits in Approvals, notes too.
    - **Notes in, runs wait** (communication-only, the default): notes go into the Brain (kind `update`, unconfirmed, written as "Webhook", never as the user); runs wait in Approvals.
    - **Allow all:** notes are kept and runs start on their own; the cadence's autonomy and budget still apply.
  - **The trigger log:** every call is in the cadence's run history: waiting, noted, started, skipped, deferred, declined, or refused (bad or missing secret, too big, too many, switched off; at most one refused line a minute per webhook). A second run call while one waits for approval is skipped.
  - **Outside content:** what a caller sent is fenced off in the run's goal as data, not instructions, and never changes the title, budget or autonomy. The run-history line never repeats it.
  - **Approvals:** a new "Webhook call" kind with an "Open Cadence" link. Saying yes to a cadence that is off or not in the open project is refused in words and the approval stays; deleting a cadence says no to its waiting calls.
  - **UI:** the form's "A webhook is called" choice with the three trust modes in plain sentences; under Runs, the webhook panel shows the listener status, both addresses with copy buttons, Copy secret / New secret (with a confirm) and a "How to call it" example with placeholders only.
  - **e2e:** `webhooks.spec.ts`: default trust (note saved, run waits, approved run starts), wrong/missing secret refused and logged, unknown webhook 404, a new secret replaces the old, strict note declined, allow-all starts without asking, and the screen's panel, clipboard and history words. It skips on Linux without a key store, like the other Vault specs.
  - **Notes:**
    - The rate limit is checked before the secret, so another program on this computer could use up a webhook's 30 calls a minute. A local program could do worse anyway.
    - A call while its project isn't open is logged every time (deferred, 409); main's rate limit is the only cap.
    - Webhook approvals have no goal, so they show whichever project is open, like the library's.
