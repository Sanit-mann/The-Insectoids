# 08 — Onboarding (First-Run Setup)

**Status:** Finalized (2026-11-12)
**Created:** 2026-11-12
**Last updated:** 2026-11-12

---

## Purpose

Take a new user from "just installed" to "the hive did something useful for me", quickly and safely: connect at least one AI engine, set up the Brain, teach the AIOS who the user is, choose safety limits, and run a first goal. Other people will use this AIOS, so the first minutes decide whether they stay.

## Reference

- **AIS-OS `/onboard`:**
  - a one-time interview of 7 questions, about 15 minutes;
  - it fills `context/` (about you and your business) and `connections.md`;
  - voice samples are pasted in;
  - answers live in an editable intake file, and the interview can be **rerun** any time.
- **Munder Difflin's setup wizard:**
  - picks the orchestrator's engine;
  - checks whether each engine can actually start **before** the user commits to it (installed, installable, manual only);
  - lets the user install and sign in to a missing CLI from inside the app.

## Flow (agreed 2026-11-12 via D2–D8)

| Step | What happens | Feeds |
|---|---|---|
| 1. Welcome | What the AIOS is, and the privacy promise: the Brain stays on this PC; nothing is uploaded; agents never see keys | 01-D8, 04-D4 |
| 2. Brain | Choose the Brain folder and backup folder (defaults offered) | 01-D4, 01-D8 |
| 3. Engines | Detect installed engines; sign in with each engine's own login; one-click install with consent. At least one must work | 04-D2, 04-D6 |
| 4. Providers (optional) | Add OpenRouter, FreeLLMAPI, local models, or API keys | 04-D3 |
| 5. About you | The Queen interviews the user: role, work, goals, how they like updates, writing voice, tools they use | 01 Global shelf |
| 6. First project | Pick a folder → its shelf is created → the folder is scanned and mapped | 01-D2, 01-E3 |
| 7. Safety and limits | Insect cap, budgets, approval strictness, protected paths | 02-D7, 06-D5, 06-D8 |
| 8. First goal | A suggested starter goal, or the user's own; a short tour of the screens as they appear | 02, 07 |

Setup can be **rerun from Settings**, and any skipped step stays on a "finish setup" checklist.

## Dependencies on other functions

- **01 Memory:** creates the Brain, the Global shelf, and the first project shelf; the code map.
- **02 Hive:** limits and approvals; the Queen runs the interview and the first goal.
- **03 Capabilities:** the core library is activated; the user's tools hint which skills to keep warm.
- **04 Connections:** engine detection, sign-in, install and providers.
- **05 Cadence:** maintenance jobs switch on (05-D7).
- **06 Workspace & Safety:** protected paths, auto mode, sandbox defaults.
- **07 App:** onboarding screens use the app's design (Cult UI `onboarding` / `wizard-expandable`).

## Open questions

- [x] Q1 — Length → D2.
- [x] Q2 — Interview style → D3.
- [x] Q3 — Interview content → D4.
- [x] Q4 — Minimum to start → D5.
- [x] Q5 — First project scan → D6.
- [x] Q6 — Safety presets → D7.
- [x] Q7 — Sample goal → D8.

*All questions closed as of 2026-11-12 (user accepted Claude's suggestions for all).*

## Decisions made

- **D1 (2026-11-12) — Onboarding is function 08**, rerunnable from Settings.
- **D2 (2026-11-12) — Quick setup (about 5 minutes).** Up front: welcome and privacy promise, Brain folder (defaults accepted in one click), at least one engine, a short "about you", and a safety preset. Everything else goes on a "finish setup" checklist.
- **D3 (2026-11-12) — "About you" is a chat interview with the Queen,** one question at a time, every question skippable, with follow-ups when useful.
- **D4 (2026-11-12) — Interview content:** role and work; current goals and priorities; how the user likes updates (short or detailed, how often); a couple of writing-voice samples; tools the user already uses. Answers are saved as **confirmed** facts on the Global shelf (the user said them), editable any time.
- **D5 (2026-11-12) — Minimum to start: one working AI engine or local model.** If none is available, setup explains the cheapest route (a free tier or a local model).
- **D6 (2026-11-12) — First project scan:** the folder is mapped right away with plain code (files, functions, links), which costs no tokens. AI-written summaries are created lazily, when a goal first needs them.
- **D7 (2026-11-12) — Safety presets:** *Careful* (more approvals, lower budgets), *Balanced* (default), *Hands-off* (more autonomy, higher budgets). No preset can turn off the always-ask list (02-D7: delete, spend, publish, push) or the command guard (06-D5).
- **D8 (2026-11-12) — Optional "try a sample goal"** on a small practice project in its own folder: the user watches the hive plan, work, get verified and finish, without touching real files. Small token cost, shown before starting.

## Change log

- 2026-11-12 — Created with AIS-OS and Munder Difflin references, draft flow and questions.
- 2026-11-12 — User accepted all suggestions → D2–D8. The draft flow is now the agreed flow, with steps 2, 4, 6 (beyond the free scan) and 8's tour moved to the checklist where skipped.
- 2026-11-12 — **Finalized by user.** Further changes go through a new change-log entry.
