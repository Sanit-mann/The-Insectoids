---
name: technical-writing
description: Write, edit and maintain developer docs (READMEs, guides, tutorials, API and config references, troubleshooting, migration notes, codemaps) that are verified against the code and kept in sync with it. Use after new features, API, dependency, setup or architecture changes, and when auditing docs for staleness. For a pure style review, use writing-guidelines.
metadata:
  kind: skill
  castes: [documenter, writer]
  tags: [docs, writing, readme, api-reference, maintenance]
  version: 1
  status: vetted
  sources:
    - repo: msitarzewski/agency-agents
      path: engineering/engineering-technical-writer.md
      license: MIT
    - repo: vercel-labs/agent-browser
      path: .agents/skills/technical-writer/SKILL.md
      license: Apache-2.0
    - repo: vercel-labs/agent-browser
      path: .agents/skills/technical-writer/references/
      license: Apache-2.0
    - repo: affaan-m/ecc
      path: agents/doc-updater.md
      license: MIT
---

# Technical Writing

Docs help a developer understand, choose, do or fix something. Docs that do not match the code are worse than no docs. Verify every claim against the source, and update docs in the same change as the code.

## When to use

- A feature, API route, CLI flag, config option, env var, dependency, setup step or architecture changed.
- A README, guide, tutorial, reference page, troubleshooting page, migration guide or changelog entry is needed.
- Auditing existing docs for stale, broken or missing content.

## When not to use

- Reviewing prose style only: use `writing-guidelines`.
- Text for the user in chat: the Queen writes that.
- Minor bug fixes, cosmetic changes or internal refactors that change no documented behavior. Docs are optional there.

## Steps

### 1. Establish the reader's task

Before drafting, know:
- Who reads it and what they already know.
- What they must understand, decide or do afterwards.
- The doc type and where it sits: discovery, first use, reference, troubleshooting.
- Versions, runtimes, permissions and other conditions that change the answer.
- What the card asks for: a passage edit, a full page, a review, or repository edits.

Infer routine details from the material. If a missing answer would change the work, report `blocked` with the question for the Queen and continue with any parts that do not depend on it.

### 2. Read before you write

- Check the Brain for the code map, related decisions and earlier doc tasks.
- Read the full section you are changing, its neighbours, and linked reference pages.
- Inspect the docs site's conventions: format (Markdown or MDX), frontmatter, navigation config, components, code-block metadata. Match them.
- Find out whether the target is generated (from types, docstrings, OpenAPI). If so, edit the source and regenerate. Never hand-edit generated output.

### 3. Ground every claim in the code

Verify by default; do not wait to be asked. Find the package and version, trace the public export to its definition, read the implementation and focused tests, and check defaults, limits and errors. A type signature alone does not prove runtime behavior. A local implementation does not prove a feature is released. Never invent an option, command result, URL, benchmark or error string. If evidence is missing, narrow or drop the claim and list it as a gap.

Full method and the claim-to-evidence table: [references/verification.md](references/verification.md).

### 4. Pick the right doc type

Keep the four kinds apart; do not mix them on one page:

| Kind | Purpose | Shape |
|---|---|---|
| Tutorial | Learning by building | One example, start to working result, checkpoints |
| How-to guide | Doing one task | Prerequisites, numbered steps, observable result |
| Reference | Looking up exact facts | Consistent fields: signature, types, defaults, errors |
| Explanation | Understanding why | Answer first, mechanism, conditions, trade-offs |

Patterns for READMEs, getting started, troubleshooting, migration guides, integration guides, changelogs and codemaps: [references/content-patterns.md](references/content-patterns.md). Outline the headings before writing prose.

### 5. Draft

- Lead with the answer or outcome. Name the exact product or API term early.
- Address the reader as "you". Present tense, active voice, imperative steps.
- One concept per section. Do not combine install, configure and use in one block.
- Each page stands alone or links its prerequisites explicitly. Link to the canonical reference instead of copying it.
- Keep qualifications (versions, limits, conditions) next to the claim they limit.
- Name mechanisms, not adjectives: "rejects a release when a required field is missing", not "robust".
- End when the task is answered: a result, a next step or a reference. No recap.

Procedures and code:
- State prerequisites, working directory, file paths, environment and permissions before the first dependent step.
- Put warnings about destructive or costly effects before the step they affect.
- Numbered steps, one action each, with an observable result where useful. Match UI labels exactly, in bold.
- Inline code for paths, commands, identifiers, env vars and literal values. Label every fenced block with its language.
- Examples include imports and config, or are labelled as excerpts with where they go. Placeholders are descriptive and consistent (`your_project_id`). Never put secrets in examples; use env vars.
- Run examples when the environment allows. Distinguish expected output from output you observed.

### 6. Edit with a reason

1. Read the passage in its full section.
2. Name the problem: accuracy, missing context, relevance, or flow.
3. Make the smallest change that fixes it; restructure only if the problem spans the section.
4. Compare with the original. Keep useful examples, qualifications and relationships.
5. Re-read for new repetition, gaps, unsupported claims and choppy flow.

Keep wording that already works. Never change code identifiers, quoted errors, UI labels or official names to satisfy a style rule.

### 7. Keep docs in sync with code

**Always update docs for:** new major features, API route or signature changes, dependencies added or removed, architecture changes, setup or config changes, breaking changes.

1. **Extract** from the code: public exports and doc comments, env vars, API endpoints, CLI flags, config keys, setup commands.
2. **Update** the README, guides, API reference, changelog and codemaps that mention them. Ship docs in the same change as the code.
3. **Breaking change:** write the migration guide before the release.
4. **Removed or old behavior:** mark it deprecated with the version; do not delete pages readers may still need.
5. **Validate:** every referenced file path exists, links resolve (also after renaming a heading or moving a page), examples compile or run, commands work.
6. **Date it:** add a "last updated" date or version where the site uses them.

Codemaps: generate them from the code, not from memory. Keep each under ~500 lines. If the Brain's code map already covers the structure, link to it or generate from it instead of keeping a second hand-written map.

### 8. Hand off

Report with `compact-output`: files changed, checks run with their actual results, claims not verified, open questions. Keep research notes out of the published doc. Working notes go on your own Brain shelf, never with secrets.

## Quality gates

- README passes the 5-second test: what is this, why care, how to start.
- Every public API has a reference entry, at least one working example, and its errors documented.
- Zero broken examples, paths or links.
- Every new feature ships with docs; every breaking change ships with a migration guide.
- Lint tools the project already has were run and real findings fixed. Never claim a check passed without running it.

## Red flags

- A claim with no source in code, tests, changelog or official docs.
- Docs describe planned behavior as available.
- A generated file was edited by hand.
- An example uses an option or flag that does not exist in the target version.
- The doc repeats a reference page instead of linking to it.
