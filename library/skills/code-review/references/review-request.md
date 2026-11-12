# Review Request Template

Use when posting a review card or handing work to a reviewer. Give the reviewer precise context, never your session history: it keeps the review on the work product, not your thought process.

## Request (fill in)

```
title:        Review: <what was built>
built:        <one or two sentences on what changed>
requirements: <original card id, its brief and acceptance criteria, or plan section>
range:        base <commit/branch> .. head <commit/branch>   (or: list of changed files)
checks run:   <commands and results, e.g. "full suite 214 passed; typecheck exit 0">
focus:        <optional: areas you are unsure about>
```

## Instructions for the reviewer

- **Read-only.** Inspect with diff, log and show commands. Do not edit files, change branches or move HEAD. Need another revision? Check it out into a separate temporary copy.
- **Do it yourself.** Do not split the review across helper agents or ask another reviewer for a second opinion. If the diff is large, review it in passes and say so.
- **The spec is a vision, not a complete list.** Where the spec is silent, judge by what a reasonable user of this software would expect. Grade such findings by their effect on that user.
- **Check plan alignment:** does the code do what the card asked? Are deviations improvements or problems? Is anything planned missing? If the plan itself looks wrong, say so.
- **Check code quality, architecture, tests and production readiness:** separation of concerns, error handling, type safety, edge cases, security, integration with surrounding code, tests that exercise real behavior, migrations and backward compatibility where schemas or APIs change.
- **List what you declined to judge:** every behavior you considered and set aside as out of scope, one line each with the reason. The requester or the Inspector rules on each; nothing is dropped silently.
- **Calibrate:** not everything is critical. Mark severity honestly.
- **Report** using the code-review output format and end with a verdict.

## After the review (requester)

- `critical`: fix immediately.
- `high`: fix before submitting the card.
- `medium` / `low`: fix if cheap and in scope, otherwise record as a follow-up in the card result.
- `q`: answer it.
- Reviewer wrong? Push back with code, tests or docs as evidence (see receiving-review-feedback). Never ignore a critical, never proceed with unfixed highs.
