---
name: accessibility
description: Build and audit UI to WCAG 2.2 Level AA - semantic HTML first, correct names/roles/states, keyboard and focus management, forms and errors, contrast, target size, reflow, motion and live regions - verified by automated scans plus manual keyboard and screen-reader checks. Use when building or reviewing components or pages, fixing a11y findings, or when a card mentions WCAG, a11y or screen readers.
metadata:
  kind: skill
  castes: [designer, coder, tester]
  tags: [accessibility, a11y, wcag, frontend]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: skills/accessibility/SKILL.md
      license: MIT
    - repo: affaan-m/ecc
      path: skills/frontend-a11y/SKILL.md
      license: MIT
---

# Accessibility (WCAG 2.2 AA)

Interfaces must be Perceivable, Operable, Understandable and Robust (POUR) for people using screen readers, keyboards, switch devices, zoom or reduced motion. Target **WCAG 2.2 Level AA** unless the card says otherwise.

**Use when:** building any UI component or page, reviewing UI code, fixing lint or audit findings (`jsx-a11y`, axe), or auditing a site.
**Detail:** [references/wcag-22-aa-checklist.md](references/wcag-22-aa-checklist.md) (every A/AA criterion with checks) and [references/patterns.md](references/patterns.md) (code for forms, dialogs, disclosure, live regions, combobox, native mobile mapping).

## Core rules

1. **Native first.** Use the element that matches the intent: `<button>` for actions, `<a href>` for navigation, `<label>`, `<input>`, `<select>`, `<dialog>`, `<details>`, headings, lists, tables, landmarks (`<header> <nav> <main> <footer>`). Native elements bring role, keyboard support and state for free.
2. **ARIA only to fill gaps.** No ARIA is better than wrong ARIA. Every custom widget needs the full name, role, state and keyboard behavior from the WAI-ARIA Authoring Practices pattern, or use a vetted component library that implements it.
3. **Everything by keyboard.** Every interactive element is reachable with Tab, operable with Enter/Space (and arrows inside composite widgets), and never traps focus. Focus order follows visual order. No positive `tabindex`.
4. **Focus is visible and not hidden.** Clear `:focus-visible` indicator with at least 3:1 contrast; sticky headers, banners and chat widgets must not cover the focused element (SC 2.4.11, new in 2.2).
5. **Every control has an accessible name** that matches or starts with its visible label (SC 2.5.3). Icon-only buttons get `aria-label`; the icon gets `aria-hidden="true"`.
6. **Meaning never by color alone.** Pair color with text, icon or pattern.
7. **Contrast:** text 4.5:1, large text (24 px, or 18.66 px bold) 3:1, UI component boundaries, focus indicators and meaningful graphics 3:1. Check every state: hover, focus, disabled-looking, placeholder, dark mode.
8. **Targets at least 24x24 CSS px** or with enough spacing (SC 2.5.8, new in 2.2). Platform guidance is larger: 44x44 pt on iOS, 48x48 dp on Android; use those for touch UIs.
9. **Reflow and zoom:** usable at 320 CSS px width (400% zoom) without two-way scrolling, at 200% text size, and with increased text spacing.
10. **Announce changes.** Status messages (saved, results count, errors after submit) reach screen readers through a live region without moving focus (SC 4.1.3).
11. **Respect motion settings.** Honor `prefers-reduced-motion`; nothing flashes more than three times a second; auto-moving content can be paused.

## Building a component (steps)

1. **Identify the role.** Button, link, tab, menu, dialog, combobox...? Pick the native element; if none fits, open the matching APG pattern.
2. **Name and describe.** Visible `<label>` (or `aria-labelledby` to visible text); `aria-describedby` for hints and errors; `aria-label` only when no visible text exists.
3. **State.** Expose state with native attributes or ARIA: `aria-expanded`, `aria-pressed`, `aria-selected`, `aria-current`, `aria-invalid`, `disabled`.
4. **Keyboard.** Implement the pattern's keys (Tab in/out, arrows within, Escape to close, Home/End where expected).
5. **Focus management.** On open, move focus into the new content; on close, return it to the trigger. On route change in a single-page app, move focus to the new page heading or main region and update the page title.
6. **Visual.** Contrast, focus ring, target size, reflow, reduced motion.
7. **Test** with the method below before handing off.

## Forms

- Each field has a programmatic label (`<label for>` / `htmlFor` + `id`). Placeholder is not a label.
- Mark required fields with `required` and a visible text cue (an asterisk with `aria-hidden="true"` plus a legend "* required").
- Group related inputs (radio sets, address) with `<fieldset>` and `<legend>`.
- Use `autocomplete` tokens for personal data (`email`, `given-name`, `street-address`) (SC 1.3.5).
- Errors: say what is wrong and how to fix it, in text next to the field; set `aria-invalid="true"` and link the message with `aria-describedby`; after submit, move focus to the first invalid field or an error summary.
- Do not ask for the same information twice in a flow; prefill or offer to reuse it (SC 3.3.7).
- Login must not depend on a memory or puzzle test: allow paste and password managers, offer alternatives to CAPTCHAs (SC 3.3.8).
- For legal, financial or data-deleting submissions: allow review, correction or undo (SC 3.3.4).

## Images, media and content

- Informative images: `alt` that conveys the purpose ("Revenue rose 23% from January to March"), never "image of". Decorative: `alt=""`. Complex charts: short `alt` plus a text or table equivalent.
- Video: captions; audio description or a transcript for visual-only information. Audio: transcript.
- One `<h1>`, sequential heading levels; landmarks on every page; a "Skip to main content" link; unique, descriptive `<title>`; `lang` on `<html>` and on passages in another language.
- Link text makes sense out of context ("Download the 2026 report", not "click here").
- Help (contact, chat, FAQ link) appears in the same place on every page that has it (SC 3.2.6).

## Dragging and gestures

Anything done by dragging (sliders, reorderable lists, maps) also works with a single pointer click or tap and with the keyboard (SC 2.5.7, new in 2.2). Multi-finger or path gestures need a simple alternative.

## Red flags (fix on sight)

- `<div>`/`<span>` with `onClick` and no role, `tabindex` and key handler: replace with `<button>`.
- `aria-label` on a generic `<div>` with no role; `aria-hidden="true"` on a focusable element or its parent.
- Positive `tabindex`; `outline: none` without a replacement focus style.
- Modal that lets Tab escape into the page behind it, or cannot be closed with Escape.
- Icon button without a name; image without `alt`.
- Placeholder used as label; errors shown only by red border.
- Skipped heading levels; content that only appears on hover and cannot be reached by keyboard or dismissed (SC 1.4.13).
- Auto-playing audio or carousels without pause.

## Testing method

Automated scans find roughly a third of WCAG issues. A clean scan is necessary, not sufficient.

1. **Static:** lint (`eslint-plugin-jsx-a11y` or the framework's equivalent) on changed files.
2. **Automated scan** per page and key state: axe-core via the browser tool (`agent-browser a11y --tags wcag2a,wcag2aa,wcag21aa,wcag22aa`) or `@axe-core/playwright` inside E2E tests.
3. **Keyboard pass:** unplug the mouse mentally. Tab through everything; check order, visible and unobscured focus, Escape, no traps, focus return after dialogs and route changes.
4. **Screen reader spot-check** of the changed flow: VoiceOver (macOS/iOS), NVDA (Windows) or TalkBack (Android). Names, roles, states and announcements must make sense. If no screen reader is available, inspect the accessibility tree (a browser snapshot shows names and roles) and mark the screen-reader check as not done.
5. **Visual:** contrast in all states and themes; 200% zoom; 320 px width reflow; text spacing; `prefers-reduced-motion`; target sizes.
6. Record what was tested and what was not.

## Output (audits and reviews)

One finding per line, most severe first:

```
src/components/Modal.tsx:31  critical  2.1.2 No Keyboard Trap (A)   Focus cannot leave modal after close; restore focus to trigger.
/checkout @375px             serious   1.4.10 Reflow (AA)           Order summary scrolls horizontally; stack columns.
src/ui/IconButton.tsx:12     serious   4.1.2 Name, Role, Value (A)  Icon button has no accessible name; add aria-label.
```

Severity: **critical** blocks a task for some users; **serious** major barrier with a hard workaround; **moderate** friction; **minor** best-practice gap. Give the WCAG criterion number, name and level for each. End with "Tested: ... / Not tested: ..." and never claim "accessible" or "compliant" from automated results alone.

## Done when

- No critical or serious issues remain in scope; the rest are listed on the task card.
- Automated scan clean for in-scope pages and states, keyboard pass done, screen-reader check done or explicitly marked not done.
