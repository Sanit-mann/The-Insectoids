---
name: compact-output
description: Write agent-to-agent messages, task results, handoffs and logs in a compact style at one of three levels (lite, terse, ultra) that cuts filler but keeps every fact, path, number, code span and error verbatim. Use for anything another agent or the Brain reads. Never for text the user reads.
metadata:
  kind: skill
  castes: [all]
  tags: [tokens, communication, handoff, reporting]
  version: 1
  status: vetted
  sources:
    - repo: juliusbrussee/caveman
      path: skills/caveman/SKILL.md
      license: Apache-2.0
    - repo: juliusbrussee/caveman
      path: skills/ultracave/SKILL.md
      license: Apache-2.0
---

# Compact Output

Say the same facts in fewer tokens. Every word another agent reads is paid for, and every fact must survive. Filler goes; payload stays exact.

## When to use

- Messages between agents (insect to manager, manager to Queen, Queen to insect).
- Task card `result` fields, handoff checkpoints, blocker reports.
- Logs, outcome records and agent notes written to the Brain.

## When not to use

- Anything the user reads. The Queen speaks to the user in normal, complete prose.
- Decisions proposed for user approval and facts sent to the approval inbox: write those at `lite` or in plain prose, because the user reads them.
- Files and artifacts people maintain: code, code comments, commit messages, PR descriptions, docs, issues, tickets. Use normal style there.
- Long memory files: use the `memory-compression` skill instead, which keeps a readable original.

## Pick a level

| Level | Shape | Use for |
|---|---|---|
| `lite` | Full sentences, no filler or ceremony | Instructions with steps, messages to light or small models, anything an approval or decision depends on |
| `terse` (default) | Fragments allowed, articles optional, one idea per sentence | Normal reports, results, handoffs between agents |
| `ultra` | Payload only: fragments, one word where one word is enough, each fact once | Logs, status records, high-volume outcome rows, repeat reports on the same task |

If unsure, use `terse`. Drop one level (toward `lite`) when the receiver is a weaker model or the content is easy to misread.

Same fact at each level:

- `lite`: "The login test fails because the token expiry check uses `<` instead of `<=`. I fixed it in `src/auth/session.ts:42`."
- `terse`: "Login test fail: expiry check used `<` not `<=`. Fixed `src/auth/session.ts:42`."
- `ultra`: "Expiry `<` vs `<=`. Fixed `src/auth/session.ts:42`."

## Rules (all levels)

1. **Answer first.** Result, then reason, then next step. Pattern: `[thing] [action] [reason]. [next step].`
2. **No ceremony.** No greeting, thanks, hedging, recap, sign-off or "let me". No filler words: just, really, basically, actually, simply.
3. **Short words.** "fix", not "implement a solution for". Standard acronyms are fine (DB, API, HTTP). Do not invent abbreviations (cfg, impl, fn): they save nothing and read worse. No arrows; write the relation in words.
4. **Articles optional, meaning never.** Drop a/an/the only when the sentence still reads in one pass. Never drop not, never, no, only, except. One dropped negation costs more than every token saved.
5. **One idea per sentence.** At most about 20 words, active voice, imperative for instructions, one term per thing. Use a pronoun only when its referent is obvious.
6. **Payload verbatim.** Code, commands, file paths, API names, IDs, numbers with units, versions and dates stay exact. Quote errors exactly, using the shortest line that decides the issue.
7. **Show changes, not files.** Report changed lines with 1-2 lines of context, or `path:line` references. Send a whole file only if it is new or mostly changed.
8. **Each fact once.** No restating, no summary after a list.
9. **No status chatter.** The harness records progress and heartbeats for free. Write when you finish, get blocked, fail, or change direction; not between routine steps.
10. **No persona.** No prefixes, announcements, mangled grammar for flavor, decorative tables or emoji. If the compact phrasing is not shorter than plain, use plain.
11. **Keep the language.** Compress style, not language. Technical terms and error strings stay in their original form.

## Switch to plain sentences for

Write these parts in full sentences at any level, then resume:

1. Security warnings.
2. Irreversible, destructive or costly actions (delete, publish, push, spend). These also need approval through the Queen.
3. Ordered steps where fragments could scramble the order.
4. A question or a choice of options, so the answer comes back right the first time.
5. Anything with two possible readings.
6. When the receiver asked again or misunderstood the last message.

## Templates

Task result (taskboard `result` field):

```
status: done | blocked | failed
did: <one line per outcome>
changed: <path:line or file list>
checks: `<command>`: <actual result>
open: <unresolved issues, or none>
next: <next step, or none>
```

Handoff checkpoint (before a session ends or context is compacted):

```
task: <card id> <title>
state: <where work stopped>
next: <exact next step>
blockers: <or none>
files: <paths touched>
notes: <facts the next agent needs and cannot get from the Brain>
```

Blocker report to a manager or the Queen:

```
blocked: <card id>
cause: <exact error or missing input>
tried: <what was tried, one line each>
need: <decision, access or input required>
```

Leave out empty lines instead of writing "n/a" unless the field is required.

## Pre-send check

1. First sentence announces what you will do? Delete it.
2. Last sentence recaps or offers more help? Delete it.
3. Every not / never / no / only / except still present?
4. Every code span, path, number and error verbatim?
5. Any sentence with two readings? Rewrite it as a full sentence.
6. Is the reader the user? Then do not use this skill.
