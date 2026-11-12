---
name: writing-guidelines
description: Review docs and other prose against general writing rules (planning, voice, banned filler and hype words, sentence patterns, headings, lists, code samples, numbers and units, typography, links, accountability) and report findings as file:line lines with a fix. Use when asked to review docs, check writing style, audit prose, or check voice and tone.
metadata:
  kind: skill
  castes: [writer, documenter, reviewer]
  tags: [writing, docs, review, style]
  version: 1
  status: vetted
  sources:
    - repo: vercel-labs/agent-skills
      path: skills/writing-guidelines/SKILL.md
      license: MIT
    - repo: vercel-labs/agent-skills
      path: README.md
      license: MIT
    - repo: vercel-labs/agent-browser
      path: .agents/skills/technical-writer/references/editorial-standards.md
      license: Apache-2.0
---

# Writing Guidelines

Check prose against rules that make it clear, direct and accurate. Report problems precisely; do not rewrite the document unless asked.

## When to use

- A card asks to review docs, check writing style, audit prose, or check voice and tone.
- Before shipping a page written by another agent.
- As the style pass at the end of `technical-writing`.

## When not to use

- Checking whether technical claims are true: that is part of `technical-writing` (verification).
- Agent-to-agent messages: those follow `compact-output`, not these rules.

## How to review

1. Get the target files or pattern from the card. If none is given, report `blocked` and ask the Queen which files.
2. Read each file in full. Identify its content type (tutorial, how-to, reference, explanation, troubleshooting, README, release note) and its destination.
3. Check for a project style guide or house rules. They override these defaults where they conflict.
4. Apply the rules below. Judge in context: a listed word is a signal to check, not proof of a problem.
5. Never flag exact names, code, quoted errors, UI labels or quotations because they contain a listed word.
6. Output findings in the format at the end.

## Rules

### Planning
- The page has one clear purpose and one content type. Do not mix tutorial, reference and explanation.
- Titles describe the reader's task or question ("Deploy a preview branch"), not the feature's internals.
- The page opens with the answer or outcome (a short summary first on long pages).

### Voice and tone
- Address the reader as "you". Use imperative verbs for steps.
- Active voice and present tense. Passive voice only when the actor is unknown or irrelevant.
- Contractions are fine where natural. Use "we" only for real commitments by a named team.
- Professional, direct, specific; like a knowledgeable colleague.
- Tone fits the type: tutorials encourage and explain; how-tos are brisk; references are neutral and exact; troubleshooting is calm and diagnostic.
- Keep real uncertainty. Remove hedges from verified instructions, but never turn a conditional behavior into a guarantee.

### Words to cut or replace
- **Unsupported ease and quality claims:** easy, simple, simply, quick, seamless, effortless, powerful, innovative, comprehensive, robust. Replace with what the reader does or what the system provides.
- **Inflated words:** delve, foster, leverage, utilize, facilitate, empower, streamline, cutting-edge, game changer, paradigm shift, tapestry, realm, beacon, multifaceted, meticulous, intricate, paramount, transformative, elevate, embark, supercharge, harness, ever-evolving. Check inflected forms too.
- **Empty intensifiers:** just, very, basically, obviously, literally, honestly, actually, truly, fundamentally, importantly, crucially, inherently. Keep a qualifier only if it carries real scope or uncertainty.
- **Filler phrases:** "it's worth noting", "at the end of the day", "when it comes to", "at its core", "in today's world", "the reality is", "going forward", "let's dive in". "In order to" becomes "to". Do not swap one filler for another.
- **Vague metaphors** that hide a mechanism: substrate, nexus, flywheel, north star. Keep precise domain terms.

### Sentence and paragraph patterns

| Pattern | Example | Fix |
|---|---|---|
| Negation-and-reveal | "This isn't X. It's Y." / "not just X, but Y" | State Y directly; keep negation only for a real limit |
| Throat-clearing | "Here's the thing", "Let me be clear" | Start with the information |
| Dramatic reveal | Self-answered question or staged colon | State the answer |
| Importance claim | "plays a vital role", "this distinction matters" | Describe the role and its effect |
| Trailing significance | "..., highlighting the need for X" | Name the consequence or cut it |
| Vague authority | "experts agree", "studies show" | Cite the source or remove the claim |
| Inflated verb | "serves as a centralized hub" | Use the action: "stores", "routes" |
| Synonym cycling | one component called tool, platform, system | One term per thing |
| Forced triplets | lists padded to three items | Use the natural number of items |
| Coverage announcement | "This guide covers X, Y and Z" | Delete; headings already navigate |
| Decorative ending | aphorism or recap closing a section | End on the useful fact or action |
| Fake human touch | invented anecdotes or opinions | Remove; voice comes from relevant detail |

Also check across the whole document: repeated sentence openings and shapes, explanations repeated across sections, a connected explanation chopped into abrupt fragments, and sentences so dense the reader must backtrack.

### Headings and structure
- Sentence-case headings, no terminal periods, logical hierarchy without skipped levels.
- Descriptive subheadings: question headings for real questions, imperative headings for tasks.
- One concept per section. Keep required instructions in the main flow, not hidden in callouts.

### Lists and tables
- Bullets for parallel, distinct items; numbered lists for ordered steps; tables for items that share attributes.
- Keep connected reasoning as paragraphs; bold labels cannot fix disconnected prose.
- List items share one grammatical form. If items use a bold label plus description, every item does.

### Code samples
- Every fenced block has a language tag.
- Examples are complete (imports, config) or clearly labelled as excerpts with where they go.
- Lead with the project's primary language when several are shown; keep variants consistent.
- Keep blocks short and narrow (aim for about 25 lines and 80 columns) unless the destination says otherwise.
- Inline code for paths, commands, identifiers, env vars and literal values.
- No secrets; use env vars and descriptive placeholders.

### Placeholders, numbers and units
- Placeholders are descriptive `snake_case` text (`your_project_id`), used consistently. Avoid `<name>` forms in shell commands.
- Numbers as numerals with units, separated by a space: `64 KB`, `200 ms`. Keep units consistent; distinguish bytes from bits and KB from KiB.
- Expand unfamiliar abbreviations on first use. Common developer terms (API, URL, HTTP, HTML, CSS) need no expansion for developers.

### Typography and source formatting
- No em dashes as sentence punctuation in new prose; rebuild the sentence or use a colon for lists, labels and examples.
- One quote style per document, following the destination. Never change quotes inside code or exact quotations.
- No decorative emoji. Bold for exact UI labels; other emphasis sparingly.
- Source files: do not hard-wrap prose lines, no decorative `---` rules, one blank line between blocks.

### Links
- Descriptive link text. No "click here", no "this link", no sentence that only announces a link.
- Never fabricated URLs. Link the specific page that supports the claim.

### Accountability (AI-assisted writing)
- The author is accountable for every claim, whoever drafted it. Unverified claims are flagged, not shipped.
- Plan the page (type, reader, outline) before drafting.
- Disclose AI assistance where the destination's policy requires it.
- Change descriptions (PRs, changelogs) say what changed and why, in the author's own review.

## Output format

One finding per line, grouped by file, in line order:

```
<file>:<line>: <severity> [<rule>] <problem>. Fix: <replacement or action>.
```

Severity:
- `error`: misleading, wrong, or blocks the reader (vague authority, broken structure, missing language tag on a command block).
- `warn`: clear rule breach that weakens the page (hype word, passive step, synonym cycling).
- `nit`: minor polish.

End with one summary line per file: `<file>: <n> error, <n> warn, <n> nit.` If a file has no findings, write `<file>: clean.` Do not pad the report with praise or general advice.
