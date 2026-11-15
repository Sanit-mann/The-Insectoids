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
- **A5 Maintenance and proposals: done (2026-11-14).** I wrote the contract (the `maintenance` when-shape with its own schedule, `MAINTENANCE_JOBS`, outcome `done`, `CadenceView.builtIn`, `backup-api.ts`, `CadenceProposalPayloadSchema`), then five parallel workers built the Brain host, backups (main and Settings), cadence proposals, the Cadence screen and the e2e spec. Unit tests: 1051 pass, 4 skipped. e2e: 166 passed, 3 skipped; the new maintenance spec passes in full. Lint and typecheck are clean.
  - **Built-in jobs** (05-D7), on by default, on the Global shelf with fixed ids `maint-<job>`, so they run whichever project is open, or none, and while the hive is paused. They are code, not goals: no Queen plan, no tokens. Each logs `done` with what it did, or `failed`.
    - **Brain health check** (every 6 hours): the health score and near-duplicate count.
    - **Daily backup** (03:00): `VACUUM INTO` a new file in the backups folder; the newest 7 matching files stay, nothing else in the folder is touched.
    - **Tidy the Brain** (daily): unused agent notes fade (only while idle on a schedule) and agent-only near-duplicates fold together, archived as "merged into" and reversible. Anything the user wrote, edited or confirmed is never touched.
    - **Stale task cleanup** (daily): cards left open over a day after their goal was done or cancelled are closed with a note. Cards of stuck goals stay, since those can be re-planned. Nothing is deleted.
    - **Skill review** (weekly): proposes retiring skills that keep failing or go unused.
    - **Rules:** users can switch a job off, run it now or change its schedule; they can't create, rename or remove one. Deleting one switches it off, with a note.
    - **The Librarian's 6-hour timer** now only wakes the LLM review; scoring, fading and retirements come from the jobs, so switching a job off really stops it. The start-up score stays, and Tidy now / Check now still work on demand.
  - **Backups** (01-D8): local only. The folder is a setting in main (default `<userData>/backups`), sent to the host at every start and on change; a folder inside the Brain folder is refused.
    - **Restore never overwrites:** the chosen copy goes to a new `<userData>/brain-restored-<stamp>/brain.db` and the Brain switches there through the Brain-folder path. The old Brain stays, so a restore can be undone by switching back. Refused while a goal is running.
    - **Settings → Backups:** folder, status in words, Back up now, the list with Restore (with a confirm).
  - **Cadence proposals** (05-D3): after a user goal, if much the same request was asked on 3+ occasions in that project in the last 90 days (asks within an hour count once), the Queen proposes a cadence in Approvals (kind `schedule`, now labelled "Cadence proposal"). The schedule is guessed from the gaps (daily, weekly at the usual time, or every N days). Yes creates it in that project (refused in words if it isn't open); no means it is never proposed again. Cadence-started goals never count, and a request that already has a cadence isn't proposed.
  - **UI:** a Housekeeping section on the Cadence screen (shown even with no project open): each job's sentence, schedule, next and last run, a switch, Run now, Runs and Change schedule, and the note that jobs cost no tokens. The user's own list and form never show maintenance.
  - **e2e:** `maintenance.spec.ts`: five jobs from the first start; delete switches off; no user-made jobs; schedule kept; backups keep 7; restore brings back the older Brain in a new folder and switching back undoes it; three similar goals make one proposal, a yes makes the cadence, a fourth ask makes no second one; the Housekeeping screen runs a backup and shows "Done". Existing cadence specs now ignore built-in jobs.
  - **Notes:**
    - Backup file names go down to the second, so two backups in the same second are refused, not overwritten.
    - A scheduled backup waits up to 30 s at start for the host to learn the folder.
    - Proposal approvals have no goal, so cancelling a goal doesn't withdraw a proposal.
- **B1 Digest: done (2026-11-14).** I wrote the contract (in `hive-api.ts`: `DigestBadgeSchema` in the snapshot, `DigestViewSchema`, command `markDigestSeen`, `HiveApi.digest()`), then three parallel workers built the host side, the UI and the e2e spec. Unit tests: 1059 pass, 4 skipped. e2e: 171 passed, 3 skipped; the new digest spec passes in full. (One full run had a single failure in the Brain dashboard UI spec that did not repeat.) Lint and typecheck are clean.
  - **What counts** (05-D8): cadence runs the user didn't start (schedule, catch-up, wake, file, event, webhook; never Run now) and the built-in jobs, since the user last said "Got it". On the very first start that moment is now, so old history never shows. It is kept in the host's settings file.
  - **When it opens by itself:** one of the user's own cadences ran (whatever happened), or a built-in job failed. Routine housekeeping is listed but never opens it, so the 6-hourly health check doesn't pop it up every morning. It opens only when the user arrives: the app opens, or the window is shown from the tray or restored (a new `window-shown` push from main). Never in the middle of use, and not on mere focus changes, which also fire as other windows come and go on macOS (CI found it); then the top-bar dot shows. At most once per period, and it waits while the user is typing. The first full e2e run showed why: it popped up over the screen mid-use.
  - **What it shows:** a one-line headline ("While you were away: 3 runs, 2 done, 1 waits for you. 41,200 tokens ($0.12)."); totals (runs, done, failed or stuck, still open, runs with problems, housekeeping, tokens, cost); "Waits for you" first, with every waiting approval by kind and a link to Approvals; then each cadence with its outcome counts, the goals it started as they stand now (with tokens, cost and an "Open goal" button) and its notable run lines; then the built-in jobs.
  - **The merge-blocks-next-runs question (from A1):** kept as it is: unmerged work doesn't pile up. The digest now says it plainly on the goal: "Waiting for you to approve its merge; its next runs are skipped until then."
  - **Where:** a dialog with "Got it" (marks it read) and "Later" (keeps it unread); a top-bar "While you were away" button with a dot when unread; and a fold-open digest on the Cadence screen.
  - **Performance:** one indexed query per snapshot (Brain migration v14 adds an index on `cadence_runs(at)`).
  - **e2e:** `digest.spec.ts`: nothing on a fresh start; an "overnight" interval run on the fast clock makes it unread and it opens by itself when the window comes back, with the cadence, its goal and the waiting plan; "Got it" clears it; Run now doesn't count; routine housekeeping is listed but doesn't open it; "Later" keeps it unread and the button reopens it.
  - **Notes:**
    - Runs of deleted cadences are left out of the digest.
    - "Waits for you" counts the approvals the Approvals screen shows (the open project's and those tied to no goal), not other projects'.
- **B2 Notifications and background: done (2026-11-14).** I wrote the contract (`background-api.ts`; `SetupState.notifications` and `startWithComputer` with their IPC; the `open-screen` push), then three parallel workers built main, the renderer and the e2e spec. Unit tests: 1088 pass, 4 skipped. e2e: 179 passed, 4 skipped (one of the new start-with-computer tests runs only on Linux). Lint and typecheck are clean.
  - **Notifications** (05-D8), on by default, from main (`notifier.ts`, a pure decision over snapshots plus grouping):
    - **Only two things notify:** something new waits for approval ("Approve the plan for …", or "N things wait for you"), and a failure ("Stuck: <goal>", "<cadence> failed", or "N things went wrong"). Done goals, started, skipped or deferred runs, notes, refused webhook calls and routine housekeeping stay quiet: they're in the digest.
    - **Only while the window isn't in front**, grouped over 3 s, at most one per kind a minute. The first snapshot, a Brain restart or a project switch is a new baseline, so nothing old notifies.
    - **A click** shows the window on Approvals, on the stuck goal, or on Cadence (`open-screen` push). The digest doesn't pop up over a screen opened that way.
    - **A Settings switch** turns them off; the OS's do-not-disturb still applies.
  - **The tray menu:** status in words; "Needs you (N)" opening Approvals; "Next: <cadence> <when>" or "Nothing scheduled"; a "Run now" submenu (the project's cadences, then the built-in jobs; disabled with the reason while paused); "While you were away" when the digest is unread; Pause/Resume; "Start with my computer" (checkbox); Open; Quit. It rebuilds every minute so the "Next" words stay true.
  - **Start with my computer:** off by default, in the tray and in Settings. It registers a login item on Windows and macOS, and the app then starts hidden in the tray. On Linux it isn't offered yet ("add The Insectoids to your desktop's startup apps"). Tests never touch the real login item: under e2e a fake stands in.
  - **e2e:** `background.spec.ts`: the tray's state as the hive idles, waits for approval, pauses and resumes, with the Run now list and the next run; notifications for a new approval only while the window is in back, none for finished goals or started runs, none while in front or switched off; start with my computer on and off (or unavailable on Linux).
  - **Notes:**
    - Electron 45 has no `openAsHidden`, so on macOS the hidden start relies on `wasOpenedAtLogin`.
    - Not yet seen in a real desktop session: the OS notification itself and the tray menu are checked through their models in tests.
- **C1 Accessibility (WCAG 2.2 AA): done (2026-11-14).** With the user's yes, `@axe-core/playwright` 4.14.0 (and `axe-core` 4.14.0) was added as a test-only dependency, pinned exactly (released 2026-10-15 and 2026-10-05, MPL-2.0). I wrote the first scan and fixed what it found; then two parallel workers covered dialogs and other states, and keyboard-only paths. Unit tests: 1088 pass, 4 skipped. e2e: 188 passed, 4 skipped. In that run one Playwright worker process crashed natively (exit 0xC0000409) during the digest overnight test; that spec then passed twice in a row on rerun. Lint and typecheck are clean.
  - **Automated checks** (axe in legacy mode, because Electron can't open the extra page it normally uses; tags WCAG 2.0/2.1/2.2 A and AA; serious and critical findings fail, everything else is written to a report):
    - `accessibility.spec.ts`: all 11 screens in both themes, with real content: zero findings at any impact.
    - `accessibility-states.spec.ts`: the 9 setup wizard steps, then the states a screen pass doesn't reach: plans waiting and running, selected and decided approvals, the cadence form under all five "When" choices, runs, the webhook panel, Housekeeping, both digests, Backups and its restore dialog, Brain records, the editor, the graph and code views, Library details, Connections tabs, Taskboard card details and the Living hive. Again zero findings, in both themes.
  - **Keyboard only** (`keyboard.spec.ts`, Tab/Shift+Tab/Enter/Space/Escape/arrows, no clicks): a skip link to the main content; switching screens moves focus to the screen's heading; giving the Queen a goal and approving its plan; moving through Approvals with arrows and approving; making a cadence; running and switching a built-in job; hold-to-delete with Space; both dialogs trap Tab, close on Escape and give focus back; keep-awake with Space and its live status. Focus is visible throughout.
  - **What was fixed:**
    - Light-theme status colours (they were the dark ones, about 2:1 on white): new light `--st-*` steps, each ≥ 4.5:1 on every light surface. Light muted text is now `#625a4c`, and an `--on-blocked` token was added for text on the danger colour.
    - Faded content (opacity) that dropped text below 4.5:1: unsupported engine cards and decided approvals now use a dashed border instead. Hold-to-approve shows its progress as a bar under the label.
    - Focus: dialogs opened without a trigger give focus back to their opener; switches stay focusable while busy (`aria-disabled`); after approving, focus moves to the goal or back to the list item; closing the cadence form returns focus to its opener; the new-cadence form focuses Name; the goal card shows the focus ring.
    - Names: weekday buttons show "Mon" with the name "Monday"; Kanban cards' names match their visible text; the Library full text is a focusable, labelled region; long commands wrap instead of scrolling sideways.
  - **By reading code** (axe can't check these): every dialog is named, traps focus and closes on Escape; error alerts, the status pill, backup status, copy feedback and the end of a hold are announced; icons are hidden from screen readers or sit inside named controls.
  - **Notes:**
    - Many buttons use `disabled` while they work, which can drop keyboard focus as the switch did. Only the switch is fixed; the rest is a follow-up.
    - A cadence's last-run line has no live region on purpose: its relative time keeps changing and would keep announcing.
    - No real screen reader (NVDA, Narrator, VoiceOver) has been run; the screen-reader pass is the axe rules plus the code reading above.
- **C2 Obsidian export: done (2026-11-14).** I wrote the contract (`export-api.ts`), then three parallel workers built the vault builder in `packages/brain`, the wiring (host, main, Brain screen) and the e2e spec. Unit tests: 1123 pass, 4 skipped. e2e: 194 passed, 4 skipped. Lint and typecheck are clean.
  - **What it makes** (01-D11, E13): a read-only copy of the Brain as an Obsidian vault in `<picked folder>/Insectoids Brain`: README.md; `<Shelf>/<Kind plural>/<Title>.md` notes with YAML frontmatter (id, kind, shelf, trust, owner, source, dates, version, confidence, importance, status, tags, aliases); and a "## Links" section built from the Brain's real links (`[[file|title]]`, e.g. "Replaces", "Replaced by", "Merged into"). Links only point at notes in the export. File names are Obsidian- and Windows-safe and unique across the vault. Current notes by default; "Include archived notes" adds archived and superseded ones.
  - **Secrets are never written:** title, body and source go through the Brain's secret patterns and matches become `[secret removed]` (the note says `redacted: true`). Each finished file is checked again, and a note that still matches is left out, along with links to it.
  - **Your files are safe:** an existing `Insectoids Brain` folder the app didn't make is refused in words. A marker file lists what the last export wrote, so the next one replaces only those, and refuses if a new note would land on a file it didn't make.
  - **Where:** the Brain screen's Notes view: "Export to Obsidian", "Include archived notes", the result in words, and "Show folder". The picker remembers the last folder; a folder inside the Brain folder is refused.
  - **A gap the work found and fixed:** the Brain's secret guard didn't check a record's `source`, so a secret could have entered the Brain there. It does now, with a test.
  - **e2e:** `obsidian-export.spec.ts`: export from the UI; README, marker and notes in shelf/kind folders with frontmatter; every `[[link]]` resolves to a note; a task links to its decision; a re-export drops an archived note but keeps the user's own files; archived notes come back with the option, and the old fact links to its replacement; a secret planted past the guard (an e2e-only host hook writes a record, then swaps the secret into its body through a second database connection) appears in no file and the note says redacted; a folder the app didn't make is refused and left untouched.
  - **Notes:**
    - Not opened in the real Obsidian app; the tests check the vault's files and links.
    - Shelves of projects that aren't open use their id as the folder name; the host only knows the open project's name.
- **C3 Installers: done locally (2026-11-14); the CI release build runs at the first version tag.** With the user's yes, `electron-builder` 26.18.0 (MIT, released 2026-10-20) was added as a build-only dependency, pinned. A parallel worker wrote the release workflow and the install notes. Unit tests: 1123 pass, 4 skipped. e2e: 194 passed, 5 skipped (the new packaged-app test skips unless pointed at a build). Lint (now ignoring `release/`) and typecheck are clean.
  - **Supply chain:** the user also chose to make the 14-day rule a pnpm setting (`minimumReleaseAge: 20160` in `pnpm-workspace.yaml`): every newly resolved package, direct or indirect, must be at least 14 days old. Turning it on showed that 93 lockfile entries from earlier steps were younger than 14 days that day (among them Electron 45.2.3, Vite, Vitest, Playwright and typescript-eslint, and the platform builds of rolldown, Tailwind's oxide and pnpm itself), so the rule hadn't actually been kept before. With the user's choice they are listed as exact-version exceptions, to be dropped as each one ages. `electron-winstaller` (Squirrel, unused) may not run its install script.
  - **Packaging** (`apps/desktop/electron-builder.yml`): the app is fully bundled, so it ships no node_modules (the workspace packages moved to devDependencies). The resources follow the layout `doors.ts` already expected: `doors/` (the five helper scripts), `ort/` (the meaning-search wasm), `tree-sitter/` (the code map), `library/` and the icons. Targets: Windows NSIS x64 (per user, can change the folder); macOS dmg arm64 and x64 (no Developer ID, so ad-hoc signed, which Apple silicon needs to run at all; hardened runtime off); Linux AppImage and deb x64 (`the-insectoids`). Nothing is published from the build.
  - **A packaging bug found and fixed:** the code map failed in the packaged app ("Unable to determine script URL"): Node decided `tree-sitter.js` was ESM from the nearest package.json above it. A `{"type": "commonjs"}` package.json now ships next to it.
  - **Checked on this PC** (with the user's yes): the Windows installer (122 MB) installed silently into a scratch folder; `packaged.spec.ts` started the installed app with a throwaway data folder: resources present, the Brain host running from the app archive, the code map ready, the library loaded, and a goal reached its plan. The silent uninstall then left no files, uninstall entry or shortcuts. `packaged.spec.ts` runs only when `INSECTOIDS_PACKAGED_EXE` is set.
  - **Release workflow** (`.github/workflows/release.yml`): on a `vX.Y.Z` tag (or by hand as a dry run that only uploads artifacts), it builds on Windows, macOS and Linux, checks the tag matches the app version, and puts the installers plus `SHA256SUMS.txt` in a **draft** GitHub release that a person publishes. Only that last job may write to the repo. A commented placeholder marks where SignPath signing goes once the project is approved.
  - **README:** an Install section (which file to pick, opening unsigned builds on each OS, checking SHA256SUMS, where data lives, uninstalling). **CONTRIBUTING:** building installers and how releases are made.
  - **Not checked yet:** the macOS and Linux installers haven't been built (they need those systems: the release workflow is their first build); the workflow itself hasn't run; Windows builds are unsigned until SignPath approves the project.
- **C4 Update checks: done (2026-11-14).** With the user's choice of "restart to update", `electron-updater` 6.8.11 (MIT, released 2026-10-20) was added, pinned, and bundled into main (the app still ships no node_modules). I wrote the contract (`update-api.ts`), then three parallel workers built main, the Settings section and the e2e spec. Unit tests: 1144 pass, 4 skipped. e2e: 199 passed, 5 skipped. Lint and typecheck are clean.
  - **What it does** (09-D4): asks the project's published GitHub Releases (drafts and pre-releases never count) whether a newer version exists, about a minute after start and then once a day, while "Check for updates" is on (default on; app.json `updates: false` turns it off and nothing is fetched). "Check now" any time. Never forced: a newer version is shown; the user presses Download (background download, with progress); then "Restart to update" when they're ready. An older or equal version is "up to date": never a downgrade.
  - **Where it can install itself:** Windows (NSIS) and the Linux AppImage. macOS (no Developer ID) and the .deb get "Open the download page" instead (only the github.com release URL the last check found can be opened).
  - **Privacy:** nothing about the user is sent. electron-updater normally sends a random per-install id (`x-user-staging-id`) on every request; it is replaced with an all-zero id. The user agent is the generic default.
  - **Packaging:** builds now carry a GitHub publish config, so they include `app-update.yml` and write `latest*.yml`; nothing is published from a build (`--publish never` locally and in CI). macOS also builds a zip, because update checks read `latest-mac.yml`, which points at it; the release workflow uploads the zips and `*.blockmap` files (for smaller, differential downloads).
  - **UI:** Settings → Updates: the version, the switch, the status in words (a live region), one action button that keeps keyboard focus as it changes (Check now / Download / Restart to update / Open the download page), a progress bar, "What's new", and a privacy line. A small top-bar notice ("Update available" / "Update ready") opens that section. Never a dialog.
  - **e2e:** `updates.spec.ts` against a local fake feed (a `latest*.yml` and a small installer with its real sha512): newer → available → download → ready → restart requested (under e2e the app records it instead of quitting); same and older versions are up to date and nothing is downloaded; off makes no request at all; a broken feed or closed port gives an error in plain words. The e2e updater cache is removed afterwards.
  - **Not checked yet:** a real update between two published releases (the first chance is v0.0.3 → the next version).
- **C5 Phase 3 demo: done (2026-11-14).** The real demo passed on the first run, on the **installed** app: the Windows installer was rebuilt from the current code, installed silently into a scratch folder, used for the demo, then uninstalled (no files, uninstall entry or shortcuts left). The user consented to the real run after a cost estimate, and to the install. It used a throwaway copy of the tiny-text sample project and a throwaway data folder.
  - **Runner:** `apps/desktop/e2e/phase3-demo.spec.ts` (`INSECTOIDS_DEMO3=real|fake`, optional `INSECTOIDS_PACKAGED_EXE`; skipped in the normal suite). A test-only switch, `INSECTOIDS_E2E_TRAY_CLOSE=1`, lets closing the window go to the tray as in the real app. The free dry run with the scripted engine passed first.
  - **What happened** (14:10 UTC run, 2.5 minutes):
    1. A weekly cadence, "Weekly report" ("Every Saturday at 19:42", autonomy "run on its own"), was due two minutes later. The window was closed; the tray said "Next: Weekly report today 19:42".
    2. At 19:42 it ran on schedule with the window closed, through the Queen: Scout survey, Queen plan, one writer card, the Inspector's check. It stopped where it must: the merge into main waits for the user. A desktop notification was decided for it while the window was away ("Merge "Weekly report" into your main branch").
    3. The window came back from the tray and the digest opened by itself: "While you were away: 1 run, 1 waits for you. 137,910 tokens ($0.58)." It showed the goal waiting for its merge and that the next weekly runs are skipped until then. The screenshot is `design/screenshots/phase-3-demo-morning-digest.png`.
    4. The merge was approved: `reports/weekly.md` (17 lines: the week's two commits, what the library can do, three sensible next steps) is on main, and the sample project's tests pass.
  - **Cost:** 4 Claude Code runs, 137,910 tokens, $0.58 of subscription-equivalent usage: Scout (Haiku) 52,837 tokens / $0.01; Queen plan (Opus) 45,674 / $0.38; writer (Sonnet) 23,556 / $0.11; Inspector (Sonnet) 15,843 / $0.08. The estimate was 40k–100k tokens and $0.25–$0.70: the cost fell inside, but the tokens went over, because the estimate left out the Scout's survey.
  - **Two things the first dry run showed:** the tray refreshes about half a second after a change and notifications wait about three seconds to group, so the runner waits for both instead of reading them at once. Neither was a bug.
- **Phase 3 is complete.** Next, only on the user's yes: bump the version to 0.0.3, push the branch, tag v0.0.3 (the release workflow builds all three installers into a draft release for the user to check and publish), then merge into main.
