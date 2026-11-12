# Content patterns

Pick the pattern that serves the reader's task. These are planning aids, not mandatory section lists. Follow the destination's existing structure when it already works.

## README

Must pass the 5-second test: what is this, why should I care, how do I start.

```markdown
# Project name

One sentence: what it does and why it matters.

## Why this exists
2-3 sentences on the problem it solves. The pain, not the feature list.

## Quick start
Shortest path to a working result. No theory.

## Installation
Prerequisites with versions, then install commands.

## Usage
Most common use case, complete and working. Then configuration:

| Option | Type | Default | Description |
|---|---|---|---|

## API reference
Link to the full reference.

## Contributing
Link to the contribution guide.

## License
```

## Getting started

Take the reader from a stated starting environment to one working result. Include installation, required configuration, a minimal complete example, and a way to verify it works. Say where each file belongs. Choose one path; do not introduce every API. Link to further guides at the moment they become useful. Include necessary security boundaries even in the smallest example.

## Tutorial

State what the reader will build, what they will learn, and the assumed knowledge and starting environment. Develop one coherent example through the steps. Tell them what each step does and why before the how. Keep steps atomic: one concern each. Add checkpoints (expected output) so readers catch a mistake before it compounds. Separate teaching shortcuts from production requirements. End with the working result and a relevant next guide or reference.

## How-to guide (task guide)

Open with the outcome and any condition that decides whether the guide applies. Prerequisites before the first dependent action. Numbered steps with imperative headings, exact file locations or UI labels, and verification points. Explain why a step is needed only when it helps the reader choose or avoid a likely failure. Put troubleshooting next to the relevant step where possible. Finish with the observable result and any cleanup.

## Explanation (concept)

Answer the central question first, then the mechanism, the conditions where it applies, and the trade-offs. Use one concrete example. Use a diagram only when relationships are hard to describe in prose; keep its labels identical to the terms in the text. Distinguish related concepts readers confuse. Link to the reference and to task guides.

## API or configuration reference

Use exact symbol names as titles. For each entry give: purpose, signature, parameters, types, required fields, defaults, return values, errors and side effects. Distinguish an omitted value from `null`, empty and disabled. Use the same table shape for repeated attributes. Include version restrictions and a minimal valid example. For HTTP APIs, cover authentication, rate limits, pagination and error responses with example bodies. Link to explanations instead of embedding a tutorial in every entry.

## Troubleshooting

Start with the symptom and the context it appears in. Quote exact errors only when verified. Give a diagnostic order that separates likely causes, explain what each check establishes, then give each fix and how to confirm recovery. State the consequence before any step that deletes data, resets config or touches a live service. End with an escalation path and the diagnostic information to collect, never credentials.

## Migration guide

State source and target versions, what changes, and prerequisites. Map old concepts to new only where the mapping is valid; explain differences that need redesign. Cover data or state movement, configuration, dependencies, validation, cutover and rollback where relevant. Show before-and-after code for changed APIs, and changes to imports, types, defaults and runtime behavior. If a codemod exists, say what it handles and what needs manual review.

## Integration guide

Name the SDK, adapter, provider or framework being connected and the compatible versions. Explain setup on each side, then a complete path from input to observable result. Say which layer owns configuration, authentication, state and errors. Document capability differences and unsupported combinations. Link to the dependency's reference for details it owns.

## Cookbook example

Solve one concrete task with a focused, complete example. State prerequisites and environment, explain non-obvious choices, describe the expected result, and link to the reference for option details. If it shows a variation, make the difference explicit.

## Release note or changelog entry

State what changed, who is affected, availability and any action required. Include compatibility or migration details when they matter. Distinguish a fix from a new capability and a preview from general availability. No promotional claims.

## Codemap

Generate from the code: entry points, modules, exports, imports, routes, data models, background jobs. Keep each map under ~500 lines.

```markdown
# <Area> codemap

Last updated: YYYY-MM-DD
Entry points: <main files>

## Architecture
<Short diagram or description of how components relate>

## Key modules
| Module | Purpose | Exports | Dependencies |
|---|---|---|---|

## Data flow
<How data moves through this area>

## External dependencies
- <package>: purpose, version

## Related areas
<Links to other codemaps>
```

Checklist: generated from actual code, every path verified to exist, links tested, date updated, no obsolete references.
