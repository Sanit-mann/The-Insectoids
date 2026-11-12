# Accessible component patterns

Code for the patterns most often broken. Examples are React/TSX; the HTML and ARIA are the same in any framework. For widgets not covered here, follow the WAI-ARIA Authoring Practices Guide (APG) pattern or use a vetted library that implements it (for example Radix, React Aria, Headless UI, or the project's design system).

## Buttons and links

```tsx
// BAD: no role, not focusable, no keyboard
<div onClick={save}>Save</div>

// GOOD
<button type="button" onClick={save}>Save</button>

// Navigation is a link, not a button
<a href="/settings">Settings</a>

// Icon-only button
<button type="button" aria-label="Delete item">
  <TrashIcon aria-hidden="true" />
</button>

// Toggle button
<button type="button" aria-pressed={isBold} onClick={toggleBold}>Bold</button>
```

## Form field with hint and error

```tsx
function EmailField({ value, onChange, error }: Props) {
  const hintId = 'email-hint'
  const errorId = 'email-error'
  return (
    <div>
      <label htmlFor="email">
        Email <span aria-hidden="true">*</span>
      </label>
      <p id={hintId}>We only use this for receipts.</p>
      <input
        id="email"
        type="email"
        autoComplete="email"
        required
        value={value}
        onChange={onChange}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
      />
      {error && <p id={errorId}>{error}</p>}
    </div>
  )
}
```

After a failed submit, move focus to the first invalid field (or to an error summary with links to each field). Announce a summary with `role="alert"` only once per submit, not on every keystroke.

Radio group:

```html
<fieldset>
  <legend>Delivery speed</legend>
  <label><input type="radio" name="speed" value="std" checked> Standard</label>
  <label><input type="radio" name="speed" value="exp"> Express</label>
</fieldset>
```

## Modal dialog

Prefer the native `<dialog>` element opened with `showModal()`: it makes the rest of the page inert, closes on Escape, and moves focus inside.

```tsx
function ConfirmDialog({ open, onClose, title, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      returnTo.current = document.activeElement as HTMLElement
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      onClose={() => { onClose(); returnTo.current?.focus() }}
    >
      <h2 id="dialog-title">{title}</h2>
      {children}
      <button type="button" onClick={() => ref.current?.close()}>Close</button>
    </dialog>
  )
}
```

If a custom `role="dialog"` is unavoidable: `aria-modal="true"`, a label, focus moved in on open, Tab and Shift+Tab cycle inside (use a maintained focus-trap utility), Escape closes, background marked `inert`, focus returns to the trigger on close.

## Disclosure (show/hide)

```tsx
function Disclosure({ title, children }: Props) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(o => !o)}>
        {title}
      </button>
      <div id={id} hidden={!open}>{children}</div>
    </>
  )
}
```

Or use native `<details><summary>`.

## Live regions

```tsx
// Polite status: render the container once, then change its text
<div role="status" aria-live="polite" aria-atomic="true">{statusText}</div>

// Urgent error that must interrupt
<div role="alert">{errorText}</div>
```

The live container must exist in the DOM before its content changes, or the change may not be announced. Use `assertive`/`alert` sparingly.

## Select, combobox, menu

- Prefer native `<select>` for picking one value from a short list. It is accessible on every platform for free.
- A custom combobox or listbox is hard to get right. Use a vetted library. If you must build one, follow the APG combobox pattern: DOM focus stays on the `<input role="combobox">`; `aria-expanded`, `aria-controls` pointing at a `role="listbox"`; the highlighted option is tracked with `aria-activedescendant`; options have `role="option"` and `aria-selected`; Down/Up move, Enter selects, Escape closes and returns to the input, typing filters.
- Do not use `role="menu"` for site navigation; it is for application-style command menus. Navigation is a `<nav>` with a list of links.

## Tabs

`role="tablist"` containing `role="tab"` buttons with `aria-selected` and `aria-controls`; panels have `role="tabpanel"` and `aria-labelledby`. Only the selected tab is in the Tab order (`tabIndex={selected ? 0 : -1}`); Left/Right arrows move between tabs, Home/End jump to first/last.

## Single-page app route change

On navigation: update `document.title`, move focus to the new page's `<h1>` (give it `tabIndex={-1}`) or main region, and keep the skip link working. Many routers have an option for this; verify it with a keyboard.

## Images

```tsx
<img src="/chart.png" alt="Monthly revenue rose 23% from January to March" />
<img src="/divider.svg" alt="" />          {/* decorative */}
<svg aria-hidden="true" focusable="false">...</svg>   {/* decorative inline SVG */}
<svg role="img" aria-labelledby="t1"><title id="t1">Status: online</title>...</svg>
```

## Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

In JS, read `window.matchMedia('(prefers-reduced-motion: reduce)')` and listen for its `change` event before starting animations.

## Visible focus

```css
:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
/* Never remove outlines without a replacement */
```

Add `scroll-padding-top` equal to any sticky header height so focused elements are not hidden (SC 2.4.11).

## Native mobile mapping

| Need | Web | iOS (SwiftUI) | Android (Compose) |
|---|---|---|---|
| Name | `<label>`, `aria-label` | `.accessibilityLabel("...")` | `contentDescription` / `Modifier.semantics { contentDescription = ... }` |
| Hint | `aria-describedby` | `.accessibilityHint("...")` | `Modifier.semantics { stateDescription = ... }` for state text |
| Role | native element or `role` | `.accessibilityAddTraits(.isButton)` | `Modifier.semantics { role = Role.Button }` |
| Live update | `aria-live="polite"` | `AccessibilityNotification.Announcement("...").post()` (iOS 17+) | `Modifier.semantics { liveRegion = LiveRegionMode.Polite }` |
| Hide decoration | `aria-hidden="true"` | `.accessibilityHidden(true)` | `Modifier.clearAndSetSemantics { }` |
| Target size | 24x24 CSS px minimum | 44x44 pt | 48x48 dp |

Prefer system controls (`Button`, `Toggle`/`Switch`), which carry traits automatically. Support Dynamic Type (iOS) and font scaling (Android); test with VoiceOver and TalkBack.
