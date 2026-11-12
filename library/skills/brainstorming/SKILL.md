---
name: brainstorming
description: Finds out what the user actually wants, and why, then turns it into an approved design doc with the chosen approach. Use before planning or building anything new or changing behavior (software or not) when something that would change the result is missing from the request. Mainly for the Queen; other castes use it for design questions inside their own card.
metadata:
  kind: skill
  castes: [all]
  tags: [planning, requirements, design, queen]
  version: 1
  status: vetted
  sources:
    - repo: obra/superpowers
      path: skills/brainstorming/SKILL.md
      license: MIT
    - repo: obra/superpowers
      path: skills/brainstorming/builder-check-prompt.md
      license: MIT
    - repo: the-insectoids/functions
      path: 02-hive.md (D4, D5), 01-memory.md (D3)
      license: internal
---

# Brainstorming

You are good at building. You build what you believe the user wants, and that belief is usually thinner than it feels. This skill finds out what they want, and why, before any task card is written. When you understand the why, you make the hundred unmentioned decisions the way they would.

## Who talks to the user

Only the Queen talks to the user (02-D4). If you are a manager or insect using this skill:
- Settle everything you can yourself and mark each as **your call, with your reason**.
- Put the questions only the user can answer in your card result, most important first, and escalate to the Queen. Never contact the user directly.

## First: what do you already know?

- **Everything that matters is in the request** ("make the button blue"): do it, and say what you did. No brainstorming.
- **Something non-trivial is missing**: start the conversation below.

Before any building starts, in order: (1) lay out the approaches and have the user pick one, (2) write the design doc, short or full, (3) get it approved, (4) hand it to `writing-plans`.

## Look before you ask

Read first, then talk. Check the Brain (`using-the-brain`): boot card, decisions, confirmed facts, past outcomes and lessons for this project. Read the files or material the user pointed to. Keep going until you can explain how the relevant parts work today and what the change would touch. For a large unknown codebase or topic, post a Scout card first.

Never ask what the Brain or the project already answers. Never reopen a decision already recorded.

## Your first message

- **They already said what they want** (spec, plan, detailed request): about 200 words. Echo the request in your own words (what, for whom, why), add what you found that bears on it, and flag anything that changes the request (a constraint, a conflict, a cheaper path). Invite corrections in one line. Then:
  - if they have not said **why**, ask that: one open question, nothing to pick from;
  - else if something open would change what gets built, ask the biggest one, sketching named options with trade-offs and your pick;
  - else there is one sensible way: give the short design (approach, why not the others, the design in a few lines) and ask for approval.
- **They haven't:** one open question about the biggest unsettled thing, and say what the answer changes. Example: "If the site is mostly for people deciding whether to visit, I'd lead with hours and today's menu; taking orders is a different site. What should a visitor do when they land on it?"
- If they did not ask for a design discussion, end with a one-line offer: "Or if you'd rather I just get going, say so." If they take it, state any big how-it-gets-made choice in one line and proceed; this skill is done.

## The conversation

- **Ask only when the answer changes what gets built** and neither the request nor the project answers it. Otherwise state your call and reason as a proposal they can correct.
- **One question at a time**, in plain words, using their vocabulary. No process jargon; never quote this skill.
- **Get them describing first.** Until you know why, ask open questions with no example answers. Once you know why, sketch named options with trade-offs and your pick. When they say "you decide", propose something concrete.
- **How it gets made** (platform, language, tools, medium): if they raise the how, give options with your pick; if they talk only about outcomes, make the calls and state each in a line. Build on what existing work already uses.
- **Ground to cover** (territory, not a script): what it is and what makes it special; why now and what success looks like; goals, non-goals, anti-goals (what makes it a failure even if it works); prior art they loved or hated; current state; details they care about.
- **Make questions specific**, built on their last answer or on something you found, so they think through a consequence they may have missed.
- **Do recon** when it would help: go deeper into the project, the Brain, or (if allowed) the web. Say what you looked for and found.
- **Show, don't tell.** For screens, layouts, flows or schedules, sketch a few lines of what they would see. Offer visual mockups only if your harness can show them.
- **Spike to learn.** A quick throwaway build is often the cheapest way to learn what works. Offer one when useful; post it as a single card labeled throwaway. Keeping a spike's output is a new request that comes back through this skill.

## Lay out the approaches

Once you understand what they want, and before writing anything up, send the approaches in a message of their own:
- Generate several real alternatives; drop weak ones and any that work against their why or that existing work rules out.
- Sketch the two or three that remain concretely, with what each trades off.
- Recommend one and say why; ask which they want. If they handed you the how, say you'll go with your pick.
- If there is genuinely one sensible way, say so and why the others don't fit.

## Play it back

As soon as you understand one part (what it is for, how one piece behaves), describe it back in about 200–300 words, then continue to the next part. Only what they said goes in as theirs; anything you filled in is marked as your proposal with a reason. End each chunk by asking what is wrong or missing.

## Size the work

Say how big the work is in plain words; the user can override.

| Size | Design doc | Plan approval (02-D5) |
|---|---|---|
| Small change | Short: what you covered, a line or two per point | Approved automatically |
| Project | Full written design (below) | User approves the plan before insects start |

If it grows mid-way, stop, say so, and step up a size. If it is really several independent projects, say so, agree an order, and brainstorm one at a time.

## The written design

Write a plain document a skilled builder could plan from without going back to the user:
- intent and the why
- goals, non-goals, anti-goals
- constraints (exact values)
- **Approaches**: the two or three considered, trade-offs, which was picked and why
- the parts of the how the user decided, as they decided them
- what is left to the builder, and the calls you made (marked as yours)

**Where it goes:** a file in the project (e.g. `docs/designs/YYYY-MM-DD-<topic>.md`) unless the user prefers elsewhere. In the Brain, record a pointer and summary to the file (route, don't copy), and write each key choice as a **proposed decision** (what, why, alternatives). Decisions stay proposed until the user approves (01-D3); record their approval, never assume it.

**Builder check (projects only):** have a fresh agent (e.g. a Reviewer card) read the doc with this instruction: "You must plan this without talking to the author. List only the questions where you'd have to guess and a wrong guess would matter, ranked, each with why it changes the plan. Skip what the doc leaves to the builder. If nothing important is left, say so." Sort the answers:
- **Already answered** by the conversation or project: add the answer to the doc.
- **Minor**: settle it yourself; mark it as your call.
- **Theirs**: only the user can answer and it changes what gets built. Ask these in one message, most important first.

Update the doc, then hand it over with a short list of the calls you made. That is the only round of questions the check produces. Without a fresh agent, read the doc as that builder yourself.

## Hard gate

Nothing gets built until the user approves the design doc (short or full). Building includes product code, scaffolding, installing dependencies, creating projects, and posting implementation cards. Reading and exploring are fine.

Exceptions: the user opted out of the questions (skill done), or an approved throwaway spike. After approval the next step is `writing-plans`, nothing else.

## Red flags

| Thought | Reality |
|---|---|
| "I'll offer a menu of what they might want" | Options steer. Ask them to describe it first. |
| "I'll fill in sensible defaults" | Fine, but say them out loud. A default they never heard is one they couldn't reject. |
| "I've got my answers, I'll write the doc" | Lay out the approaches first, in their own message. |
| "Let me explain the process first" | Ask your question. The process shows itself. |
| "They said 'sounds good' to the idea" | Approval covers what you showed. An unwritten doc isn't approved. |
| "The spike works, I'll keep building on it" | Keeping it is a new request. Back through the gate. |
| "I'm an insect, I'll just ask the user quickly" | Only the Queen talks to the user. Escalate the question. |

## Done when

The user has picked an approach, the design doc is written, and the user approved it. Its key choices are recorded in the Brain as decisions with the user's approval, and `writing-plans` is next.
