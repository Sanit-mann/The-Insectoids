---
name: web-design-guidelines
description: Set a product-specific design direction before building web UI, then build and review against concrete interface rules - interactions, forms, content states, typography, layout, motion, theming, performance - with a rendered finish check and terse file:line findings. Use when building, polishing or reviewing any web page, app screen, dashboard or component.
metadata:
  kind: skill
  castes: [designer, coder]
  tags: [design, ui, ux, frontend, review]
  version: 1
  status: vetted
  sources:
    - repo: vercel-labs/agent-skills
      path: skills/web-design-guidelines/SKILL.md
      license: MIT
    - repo: affaan-m/ecc
      path: skills/frontend-design-direction/SKILL.md
      license: MIT
---

# Web Design Guidelines

Make interfaces that fit their job, feel finished, and hold up in every state. Decide the direction first, build from it, then check the rendered result against the rules below.

**Use when:** building or restyling UI, the UI "feels off" or generic, or a card asks to review UI/UX.
**Pair with:** `accessibility` (full WCAG work), `web-app-qa` (behavior bugs), `browser-automation` (rendering checks).

The rule list is written from the sources plus well-established web interface practice. The project's own design system and conventions win where they differ.

## A. Set the direction (before building)

Write a short design contract in the task workspace:

1. **Purpose:** what job the screen does, and the primary action.
2. **Audience:** who uses it, how often, and what they scan first.
3. **Tone:** one explicit direction (utilitarian, editorial, calm, dense, playful, technical...). Match the domain: a daily-use tool should be dense, quiet and scannable; a launch page or portfolio can be expressive. Do not force a landing-page layout onto a tool.
4. **One memorable detail** that makes it feel intentional.
5. **Constraints:** framework, existing components and tokens, target viewports (for example 375x812 and 1440x900), accessibility, performance.
6. **States:** for each that applies, its trigger, what the user sees, and the safe next action:

| State | Must show |
|---|---|
| Loading | Stable layout (skeleton shaped like the content), progress, cancel where supported |
| Empty | Why there is nothing, and a useful next action |
| Error | What failed in plain words, and how to recover |
| Partial | Available data, with missing parts clearly marked |
| Success | Confirmation and the next step, or undo |
| Permission | The access boundary and a safe way to request access or go back |

Mark a state "not applicable" only with a reason. "Could not test" is an untested state, not "not applicable".

## B. Build from the contract

- Show the real, usable product first. Do not hide the tool behind marketing sections unless the card asks for marketing.
- Reuse the project's components, tokens, icon set and routing patterns before inventing a new visual system. Use CSS variables or tokens so states and themes stay consistent.
- Use real or representative content and assets; images should carry the subject, not fill space.
- Do not add a dependency for a visual flourish unless it clearly pays for itself.

## C. Rules

### Interaction
- Everything works with a keyboard. Focus is always visible (`:focus-visible` ring with enough contrast), order follows reading order.
- Hit targets at least 24x24 CSS px, 44x44 on touch; enlarge the hit area with padding rather than shrinking spacing.
- Links navigate, buttons act. Use `<a>` for navigation so open-in-new-tab and middle-click work.
- The URL reflects state worth sharing or restoring (filters, tabs, pagination, open item).
- Destructive actions need confirmation or, better, undo.
- Give feedback within about 100 ms: pressed states, pending buttons that keep their label and add a spinner, optimistic updates that roll back on error.
- Never block paste. Do not hijack scroll or standard browser shortcuts.
- Overlays: Escape closes, focus moves in on open and returns to the trigger on close, background does not scroll.

### Forms
- Every input has a visible label (placeholder is not a label); clicking the label focuses the field.
- Correct `type`, `inputmode` and `autocomplete` on every field; inputs at least 16 px font on mobile so iOS does not zoom.
- Enter submits single-line forms. Keep submit enabled until submission starts; then prevent double-submit.
- Validate on submit or blur, not on every keystroke. Show errors next to the field, say how to fix them, and move focus to the first error.
- Keep user input after an error. Warn before leaving with unsaved changes.

### Content and typography
- Clear hierarchy: one primary heading, sequential levels, a type scale with few sizes and weights.
- Body line length about 45-80 characters; line height about 1.4-1.6 for body text.
- Long text wraps or truncates with a way to see the full value; nothing overflows its container at any viewport. Use `text-wrap: balance` on headings where supported.
- Tabular numbers (`font-variant-numeric: tabular-nums`) for columns, prices, timers and counters.
- Format dates, numbers and currency with the user's locale. Use proper typography: ellipsis character, curly quotes, non-breaking space between a number and its unit.
- Write labels as verbs for actions ("Save changes", not "OK"). Do not describe in text what the controls already show.

### Layout and visual
- Spacing on a consistent scale (for example 4 or 8 px steps). Align to a grid; adjust optically where icons or glyphs look off.
- Fixed-format elements (toolbars, tabs, counters, grids, tiles) keep stable dimensions when labels, hover or loading states change.
- No cards inside cards. Nested radii: inner radius no larger than outer radius minus padding.
- Color: a deliberate palette, not one hue family everywhere; meaning never by color alone; text contrast 4.5:1 (3:1 for large text and UI parts).
- Avoid generic generated looks: default purple gradients, decorative blobs, oversized empty cards, vague hero copy, stock-like atmosphere.
- Respect safe areas on notched devices; no accidental horizontal scroll at 320-375 px.

### Motion
- Motion explains a state change (where something came from or went); it never hides slowness.
- Honor `prefers-reduced-motion`: remove or shorten non-essential motion.
- Animate `transform` and `opacity`; never `transition: all`. Keep UI transitions short (about 150-300 ms) and interruptible.

### Theming
- Support light and dark if the product does: set `color-scheme`, a matching `theme-color`, and check contrast in both.
- Native controls (scrollbars, selects, date inputs) must match the theme.

### Performance (felt quality)
- Reserve space for images and embeds (width/height or aspect-ratio) so layout does not shift.
- Prioritize the main above-the-fold image; lazy-load the rest.
- Virtualize very long lists. Avoid layout thrash and large re-renders on input.
- Targets: LCP < 2.5 s, INP < 200 ms, CLS < 0.1.

## D. Rendered finish check

Source review alone cannot pass. Render the UI (see `browser-automation`) at each target viewport and:

1. Exercise every applicable state from the contract, including long content and partial data.
2. Check keyboard flow, visible focus, labels, contrast, reduced motion and touch target size.
3. Check narrow (375 px) and wide (1440 px) layouts for overflow, wrapping and stable dimensions.
4. Save a screenshot per viewport and state in the task workspace, each with a one-line note of what it shows.
5. Fix failures, then re-run the affected checks.

Report untested states and known limits honestly; never invent evidence.

## E. Review output

When reviewing existing code or a rendered page, report one finding per line, grouped by file, most severe first:

```
src/components/Checkout.tsx:42  high    Submit button disabled before validation; keep enabled, validate on submit.
src/components/Checkout.tsx:88  medium  Price column uses proportional digits; add tabular-nums.
src/app/page.tsx:15             low     Heading wraps unevenly at 375px; add text-wrap: balance.
rendered /settings @375x812     high    Toolbar overflows horizontally; allow wrap or collapse to menu.
```

Severity: **high** blocks a task or breaks at a target viewport; **medium** clear friction or inconsistency; **low** polish. End with a one-line verdict and the list of what was not checked.

## Done when

- The design contract exists and every applicable state is built.
- The rendered finish check passed at all target viewports, with screenshots saved.
- Review findings (if any) are posted on the task card in the format above.
