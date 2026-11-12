# 05 — Cadence (Schedules & Triggers)

**Status:** Finalized (2026-11-12)
**Created:** 2026-11-12
**Last updated:** 2026-11-12

---

## Purpose

Let the hive work **without being asked**: on a schedule, when something happens, or as routine upkeep. This is the "Cadence" C of the 4Cs, which AIS-OS says should come last, once Context, Connections and Capabilities work. It now can.

## What a cadence is (draft)

A **cadence** = *when* (a schedule or a trigger) + *what* (a goal handed to the Queen, or a single task card) + *limits* (budget, autonomy, approvals) + *how to report*.

Every cadence ends up as normal hive work: the Queen plans it, insects do it, the Inspector checks it. Nothing bypasses the hive.

## Reference: Munder Difflin (read from its source, MIT)

- **Four trigger types under one roof:**
  - **schedules:** recurring missions sent to an agent;
  - **context:** automatic compaction or clearing of agent memory;
  - **webhook:** inbound HTTP calls, one endpoint and secret each;
  - **org:** messages from teammates' offices.
- **Two schedule shapes:** a fixed interval, or **weekly** ("Mon and Thu 09:00"), always in the user's **local time**, so daylight saving never shifts it.
- **Trust modes for outside senders:**
  - **strict** (default): every inbound message waits for approval;
  - **communication-only:** information flows freely, but anything asking the hive to *act* waits;
  - **allow-all.**
- **Trigger history ledger:** every inbound trigger is logged.
- **Sleep handling:** by default, missed runs fire **once** when the computer wakes ("catch up once"). An optional "strong keep-alive" stops the computer sleeping while agents run, at a battery cost.
- **Built-in missions:** an hourly ops standup, a heartbeat, and auto-compaction maintenance. The required one comes back disabled, not silently gone, if the user deletes it.
- **Slack → orchestrator queue,** with a signing secret, plus short-lived Slack-triggered workers with an idle timeout.

## Draft: trigger types (proposed)

| Type | Example |
|---|---|
| **Schedule** | Every weekday 09:00; every 2 hours; first Monday of the month |
| **File/folder watch** | A new file lands in `inbox/` → summarize and file it |
| **Webhook** | A form, CI system or app calls a local URL → start a goal |
| **Service event** | New GitHub issue or PR, Slack message, email (after OAuth, 04-D5 phase 3) |
| **Hive event** | A goal finishes → start the follow-up; a budget threshold is crossed → report |
| **Maintenance** | Brain audit and health score, backups, consolidation, catalog upkeep |

## Inputs / Outputs

- **Inputs:** clocks, file changes, inbound webhooks and service events, hive events.
- **Outputs:** goals for the Queen or cards on the taskboard; a trigger log; digests and notifications for the user.

## Dependencies on other functions

- **01 Memory:** cadences and the trigger log live in the Brain; maintenance cadences run E5/E7/E12, backups (D4/D8).
- **02 Hive:** every cadence runs as hive work through the Queen; approvals (D7), big-plan rule (D11), budgets and breaker (D9).
- **03 Capabilities:** cadences can be proposed from repeated work (D6 pattern-spotting).
- **04 Connections:** webhooks and service events arrive through Connections; secrets via the vault (D4).

## Open questions

- [x] Q1 — Launch triggers → D2.
- [x] Q2 — Who creates cadences → D3.
- [x] Q3 — Trust for outside triggers → D4.
- [x] Q4 — PC asleep or off → D5.
- [x] Q5 — Unattended limits → D6.
- [x] Q6 — Built-in maintenance → D7.
- [x] Q7 — Reporting while away → D8.

*All questions closed as of 2026-11-12 (user accepted Claude's suggestions for all).*

## Decisions made

- **D1 (2026-11-12) — Cadence is function 05.** Every cadence runs as normal hive work through the Queen; nothing bypasses the hive.
- **D2 (2026-11-12) — Launch triggers:** schedules (interval and weekly, in the user's local time), file/folder watch, webhooks (one endpoint and secret each, secrets in the vault 04-D4), hive events, and maintenance. Service events (GitHub, Slack, email) arrive later, following Connections' phases (04-D5).
- **D3 (2026-11-12) — Who creates cadences:** the user, or the Queen *proposes* one when she spots repeated work (e.g. the same request 3+ times, matching 03-D6); the user approves before it is active.
- **D4 (2026-11-12) — Trust for outside triggers: "communication-only" by default.** Informational messages flow in; anything asking the hive to *act* waits for user approval. The user can loosen or tighten trust per trigger (strict / communication-only / allow-all). Every inbound trigger is logged in the Brain.
- **D5 (2026-11-12) — PC asleep or off: catch up once on wake.** Missed runs of the same cadence collapse into one run. Optional "keep awake while the hive is working" switch (off by default; costs battery).
- **D6 (2026-11-12) — Unattended limits.** Each cadence has its own token budget and autonomy level (L0–L4 from the 3Ms). Steps needing approval (02-D7) wait in the approval inbox while the rest of the work continues; nothing risky happens unattended. The Treasurer's and Watchdog's limits (02-D9) apply as usual.
- **D7 (2026-11-12) — Built-in maintenance, on by default:** Brain health check and audit (01-E12), daily local backup (01-D8), memory consolidation and dedupe (01-E5/E7), stale-task cleanup, skill success/failure review (03-D6). **Off by default:** batch rewriting of dormant library items (03-D9), because it costs tokens; the user switches it on. A deleted required job returns disabled, never silently lost.
- **D8 (2026-11-12) — Reporting while away:** a digest in the app of everything done unattended; desktop notifications only for approvals needed and failures; phone/chat delivery (Slack, Telegram) later through Connections.

## Change log

- 2026-11-12 — Created with Munder Difflin reference, draft trigger types and questions.
- 2026-11-12 — User accepted all suggestions → D2–D8.
- 2026-11-12 — **Finalized by user.** Further changes go through a new change-log entry.
