# WCAG 2.2 Level A + AA checklist

Every Level A and AA success criterion in WCAG 2.2, with a practical check. **New in 2.2** marked. 4.1.1 Parsing is obsolete in 2.2 and not listed. Normative text: the W3C WCAG 2.2 Recommendation.

How to use: in an audit, walk each criterion for each page or key state; record pass, fail (with location) or not applicable (with reason).

## 1 Perceivable

| SC | Level | Check |
|---|---|---|
| 1.1.1 Non-text Content | A | Informative images have meaningful `alt`; decorative ones `alt=""`; icon buttons named; CAPTCHAs have an alternative form. |
| 1.2.1 Audio-only and Video-only (Prerecorded) | A | Transcript for audio-only; transcript or audio track for silent video. |
| 1.2.2 Captions (Prerecorded) | A | Accurate, synchronized captions on video with speech. |
| 1.2.3 Audio Description or Media Alternative | A | Visual-only information in video is described or has a text alternative. |
| 1.2.4 Captions (Live) | AA | Live video with audio has captions. |
| 1.2.5 Audio Description (Prerecorded) | AA | Important visual content in video has audio description. |
| 1.3.1 Info and Relationships | A | Headings, lists, tables (with `<th>`/scope), labels, fieldsets and landmarks are in markup, not just styling. |
| 1.3.2 Meaningful Sequence | A | DOM/reading order matches visual meaning (check with CSS off or a snapshot). |
| 1.3.3 Sensory Characteristics | A | Instructions do not rely only on shape, position, size or sound ("the round button on the right"). |
| 1.3.4 Orientation | AA | Works in portrait and landscape unless one is essential. |
| 1.3.5 Identify Input Purpose | AA | Personal-data fields have correct `autocomplete` tokens. |
| 1.4.1 Use of Color | A | Color is not the only way to show meaning, state, links in text, or errors. |
| 1.4.2 Audio Control | A | Audio playing over 3 s can be paused or muted. |
| 1.4.3 Contrast (Minimum) | AA | Text 4.5:1; large text (24 px, or 18.66 px bold) 3:1. Includes placeholder and text over images. |
| 1.4.4 Resize Text | AA | Text resizes to 200% without loss of content or function. |
| 1.4.5 Images of Text | AA | Real text instead of text baked into images (logos exempt). |
| 1.4.10 Reflow | AA | At 320 CSS px wide (1280 px at 400% zoom), no horizontal scrolling for vertical-scrolling content, nothing lost. |
| 1.4.11 Non-text Contrast | AA | Component boundaries, focus indicators, state indicators and meaningful graphics 3:1 against neighbors. |
| 1.4.12 Text Spacing | AA | No loss with line height 1.5, paragraph spacing 2x, letter spacing 0.12em, word spacing 0.16em. |
| 1.4.13 Content on Hover or Focus | AA | Tooltips/popovers are dismissible (Escape), hoverable (pointer can move onto them) and persistent until dismissed. |

## 2 Operable

| SC | Level | Check |
|---|---|---|
| 2.1.1 Keyboard | A | All functions work by keyboard, no timing-dependent keystrokes. |
| 2.1.2 No Keyboard Trap | A | Focus can always move away (dialogs: contained while open, released on close). |
| 2.1.4 Character Key Shortcuts | A | Single-key shortcuts can be turned off, remapped, or only work when the component has focus. |
| 2.2.1 Timing Adjustable | A | Time limits can be turned off, adjusted or extended (warn before session timeout). |
| 2.2.2 Pause, Stop, Hide | A | Moving, blinking, scrolling or auto-updating content over 5 s can be paused. |
| 2.3.1 Three Flashes or Below Threshold | A | Nothing flashes more than 3 times per second. |
| 2.4.1 Bypass Blocks | A | Skip link and/or landmarks and headings to skip repeated blocks. |
| 2.4.2 Page Titled | A | Unique, descriptive `<title>`; updated on SPA route change. |
| 2.4.3 Focus Order | A | Focus order preserves meaning; dialogs receive focus when opened. |
| 2.4.4 Link Purpose (In Context) | A | Link purpose clear from its text or surrounding sentence. |
| 2.4.5 Multiple Ways | AA | More than one way to find pages (nav, search, sitemap), except steps in a process. |
| 2.4.6 Headings and Labels | AA | Headings and labels describe topic or purpose. |
| 2.4.7 Focus Visible | AA | Keyboard focus indicator is visible on every focusable element. |
| 2.4.11 Focus Not Obscured (Minimum) | AA | **New in 2.2.** The focused element is not entirely hidden by sticky headers, footers, cookie banners or overlays. |
| 2.5.1 Pointer Gestures | A | Multipoint or path gestures have a single-pointer alternative. |
| 2.5.2 Pointer Cancellation | A | Actions fire on up-event (or can be aborted/undone), not on down-event. |
| 2.5.3 Label in Name | A | Accessible name contains the visible label text, ideally at the start. |
| 2.5.4 Motion Actuation | A | Shake/tilt functions have a UI alternative and can be disabled. |
| 2.5.7 Dragging Movements | AA | **New in 2.2.** Every drag action has a single-pointer (click/tap) alternative. |
| 2.5.8 Target Size (Minimum) | AA | **New in 2.2.** Targets at least 24x24 CSS px, or spaced so a 24 px circle around each does not overlap another target. Exceptions: inline links in text, browser-native controls, essential presentation. |

## 3 Understandable

| SC | Level | Check |
|---|---|---|
| 3.1.1 Language of Page | A | `<html lang="...">` set correctly. |
| 3.1.2 Language of Parts | AA | Passages in another language have their own `lang`. |
| 3.2.1 On Focus | A | Focusing an element does not trigger a context change (navigation, submit, new window). |
| 3.2.2 On Input | A | Changing a setting does not change context unexpectedly (no auto-submit on select without warning). |
| 3.2.3 Consistent Navigation | AA | Repeated navigation is in the same relative order across pages. |
| 3.2.4 Consistent Identification | AA | Same function, same label and icon everywhere. |
| 3.2.6 Consistent Help | A | **New in 2.2.** Help mechanisms (contact, chat, FAQ) appear in the same relative place across pages. |
| 3.3.1 Error Identification | A | Errors are identified and described in text. |
| 3.3.2 Labels or Instructions | A | Inputs have labels; required formats are stated up front. |
| 3.3.3 Error Suggestion | AA | Error messages suggest a fix when one is known. |
| 3.3.4 Error Prevention (Legal, Financial, Data) | AA | Such submissions are reversible, checked, or confirmed after review. |
| 3.3.7 Redundant Entry | A | **New in 2.2.** Information already entered in the same process is prefilled or selectable, not re-typed (except for security or when it must be re-entered). |
| 3.3.8 Accessible Authentication (Minimum) | AA | **New in 2.2.** No cognitive function test (memorize, transcribe, solve) to log in unless there is an alternative; allow paste and password managers; object-recognition CAPTCHAs are allowed but discouraged. |

## 4 Robust

| SC | Level | Check |
|---|---|---|
| 4.1.2 Name, Role, Value | A | Every UI component exposes accessible name, role and current state/value; changes are announced. |
| 4.1.3 Status Messages | AA | Status updates (results count, saved, errors after async submit) are announced via `role="status"`, `role="alert"` or `aria-live` without moving focus. |

## Beyond AA (recommended, not required)

- 2.4.13 Focus Appearance (AAA): focus ring at least 2 px thick and 3:1 change in contrast.
- 2.3.3 Animation from Interactions (AAA): honor `prefers-reduced-motion`. Treat as default practice.
- 2.5.5 Target Size (Enhanced, AAA): 44x44 CSS px. Use for touch-first UI.
- 3.3.9 Accessible Authentication (Enhanced, AAA): no object-recognition tests either.

## Manual test script (per page)

1. Tab from the address bar to the end and back with Shift+Tab. Note anything unreachable, out of order, invisible or obscured.
2. Operate every control with Enter/Space/arrows; open and close every overlay with the keyboard; confirm focus returns.
3. Zoom to 200%, then set the viewport to 320 px wide. Look for overflow, overlap, lost content.
4. Apply the text-spacing values from 1.4.12 (a bookmarklet or injected stylesheet) and look for clipped text.
5. Check contrast of text, placeholders, borders and focus rings in every state and theme.
6. Turn on reduced motion and check animations.
7. Screen reader: navigate by headings, landmarks and form fields; submit a form with errors; trigger an async status message.
