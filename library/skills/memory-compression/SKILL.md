---
name: memory-compression
description: Shrink long natural-language memory (Brain summaries, agent notes, boot cards, instruction files, todo lists) into a compact form that keeps every fact, heading, code span, path and number, while the readable original is kept as its own version. Use when a memory item is loaded often or exceeds its token budget. Not for code or config files.
metadata:
  kind: skill
  castes: [librarian, queen, documenter, researcher]
  tags: [tokens, memory, brain, compression]
  version: 1
  status: vetted
  sources:
    - repo: juliusbrussee/caveman
      path: skills/caveman-compress/SKILL.md
      license: Apache-2.0
    - repo: juliusbrussee/caveman
      path: skills/caveman-compress/README.md
      license: Apache-2.0
---

# Memory Compression

Memory that loads every session costs tokens every session. Compress the prose, keep every fact, and keep a readable original that people edit and the compressed copy is rebuilt from.

## When to use

- A Brain record, boot card or agent note is loaded often and is longer than it needs to be.
- An item does not fit its token budget (default answer budget ~800 tokens, lower for small-context models).
- An instruction or memory file that agents auto-load has grown wordy.

## When not to use

- Code or config: `.py`, `.js`, `.ts`, `.json`, `.yaml`, `.yml`, `.toml`, `.env`, `.lock`, `.css`, `.html`, `.xml`, `.sql`, `.sh`. Never modify these.
- Text with no target. If someone pastes raw text without naming a file or record, ask for the target or save the text first. Do not improvise a compression in a reply.
- Something already compressed, or a stored original. Never compress a backup or an earlier compressed version.
- Messages and task results: use `compact-output` instead.

## Steps

1. **Pick the target.** One file path or one Brain record ID. Only natural-language content qualifies: `.md`, `.txt`, `.typ`, `.tex` or extensionless. For mixed files, compress only the prose and treat everything else as read-only.
2. **Guard secrets.** Refuse files whose names look like secrets (`.env`, `credentials`, `secrets`, `.netrc`) before reading them. Refuse content that holds a private key, API token or password. Secrets never enter the Brain.
3. **Mind where the text goes.** Compressing sends the text to the model doing the work. For sensitive shelves, use a local model or skip compression.
4. **Keep the original.** The readable original is the source of truth.
   - In the Brain: keep the original as its own version (never overwrite, never delete) and link the compressed version to it.
   - On disk: store the original outside any folder agents auto-load, so loaders do not read both copies.
   - If a stored original already exists, stop. Re-compress from that original, not from the compressed copy, or you lose text that was already cut.
5. **Compress** using the rules below.
6. **Validate** using the checks below. If a check fails, fix only the failing spots. Do not recompress the whole text. Retry at most 2 times. If it still fails, leave the original untouched and report the failure.
7. **Save** through the Brain's single writer as a new version with its fingerprint. Never write the database directly.
8. **Report** in compact form: target, size before and after (tokens or characters), checks passed, anything left uncompressed and why.

## Compression rules

**Remove**
- Articles where meaning survives: a, an, the.
- Filler: just, really, basically, actually, simply, essentially, generally.
- Pleasantries and hedging: "sure", "happy to", "it might be worth", "you could consider".
- Connective fluff: however, furthermore, additionally, in addition.
- Instruction padding: "you should", "make sure to", "remember to". State the action.

**Shorten**
- Short synonyms: "big" not "extensive", "use" not "utilize", "fix" not "implement a solution for".
- "in order to" becomes "to"; "the reason is because" becomes "because".
- Fragments are fine: "Run tests before push to main."
- Merge bullets that say the same thing. Keep one example where several show the same pattern.

**Preserve exactly (never change)**
- Fenced and indented code blocks: no edits to comments, spacing, line order or commands.
- Inline code in backticks.
- URLs and links, file paths, commands, environment variables.
- Technical terms, library and API names, proper nouns.
- Dates, versions, numbers and units.
- Negations and limits: not, never, no, only, except, until, unless.
- Who decided, when, and why, for decisions; source and confidence, for facts.

**Preserve structure**
- Every heading, with its exact text.
- Bullet nesting, numbered-list numbering, table rows and columns (compress cell text only).
- Frontmatter and YAML headers.
- Never merge sections across a code block.

If unsure whether something is code or prose, leave it unchanged.

## Validation checks

Compare original and compressed:

| Check | Must hold |
|---|---|
| Headings | Same headings, same text, same order |
| Code blocks | Byte-identical |
| Inline code | Every backtick span present and identical |
| URLs and paths | Every one present and identical |
| Numbers, dates, versions | Every one present and identical |
| Lists | Same nesting; count differs only where duplicates were merged |
| Negations | Every not / never / no / only / except still present in context |
| Facts | List each fact in the original; each one is findable in the compressed text |
| No additions | No new claims, no commentary about the task, no notes to yourself |

The fact check is the one that matters most. If a fact cannot be found, restore it.

## Example

Original:

> You should always make sure to run the full test suite before you push any changes to the main branch, because this helps catch bugs early and prevents broken builds from reaching production. The API gateway receives all incoming requests and routes each one to the correct service.

Compressed:

> Run full test suite before push to main. Catches bugs early, keeps broken builds out of production. API gateway receives all requests, routes each to correct service.

## Editing compressed memory

People and agents edit the original, never the compressed copy. After an edit, compress again from the new original. If the compressed version is older than its original's fingerprint, mark it stale and rebuild it.

## Red flags

- The compressed text is shorter because a fact, condition or negation is gone.
- A code block, path or number changed by even one character.
- The original was overwritten or deleted.
- The output contains remarks about the request ("User passed text directly...").
- A code or config file was "compressed".
