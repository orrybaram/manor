---
title: useEmojiAutocomplete hook and EmojiInput/EmojiTextarea components
status: done
priority: high
assignee: opus
blocked_by: [1]
---

# useEmojiAutocomplete hook and EmojiInput/EmojiTextarea components

Build the reusable UI from ADR-174 ("Behaviour" and "Components" sections).
Read `docs/decisions/adr-174-emoji-shortcode-inputs/index.md` first.

Create `src/components/ui/EmojiAutocomplete/`:

- `useEmojiAutocomplete.tsx`: the hook, typed as in the ADR.
  - State: `match` (`{start,end,query}` or null), `results`, `highlight`.
  - On `input` and `select` events, read `value`/`selectionStart` from the
    ref and run `findShortcodeQuery`. When there is a match, `await
    loadEmojiIndex()` and set `results = searchEmoji(...)`. Ignore stale
    resolutions: compare against the latest query. Before running the
    query, try `completeClosedShortcode`; if it returns a value, insert it
    directly.
  - `insert(emoji)`: compute `replaceRange`, then set the value through the
    native setter
    (`Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, next)`)
    and `el.dispatchEvent(new Event("input", { bubbles: true }))` so React
    `onChange` fires. Then `el.setSelectionRange(caret, caret)` and close.
    Put this in one small helper with a comment explaining why.
  - `handleKeyDown(e)`: return false if closed, if `results` is empty, or if
    `e.nativeEvent.isComposing`. Otherwise ArrowDown/ArrowUp wrap the
    highlight, Enter/Tab insert the highlighted entry, and Escape closes. For
    each of these call `preventDefault()` + `stopPropagation()` and return
    true.
  - On blur, close.
  - `fieldProps`: `onInput`, `onSelect`, `onBlur`, `role: "combobox"`,
    `aria-autocomplete: "list"`, `aria-expanded`, `aria-controls`,
    `aria-activedescendant`.
  - `suggestions`: a Radix `Popover.Root open` with
    `<Popover.Anchor virtualRef={inputRef} />` and
    `<Popover.Portal><Popover.Content side="bottom" align="start" sideOffset={4}
    onOpenAutoFocus={e=>e.preventDefault()} onCloseAutoFocus={e=>e.preventDefault()}>`.
    Render a `role="listbox"` of up to 8 rows (emoji + `:shortcode:`). Use
    `onMouseEnter` to highlight and `onMouseDown` with `preventDefault` to
    insert. Scroll the highlighted row into view, as `SearchableSelect` does.
    Close on `onOpenChange(false)` (outside click).
  - Compose handlers that the caller also passes (`onBlur`, `onSelect`,
    `onInput`) so neither side's handler is dropped.
- `EmojiAutocomplete.module.css`: list styles, modelled on
  `src/components/ui/SearchableSelect/SearchableSelect.module.css` (reuse the
  same CSS variables).
- `EmojiInput.tsx`: `React.forwardRef` wrapper around `ui/Input` with the
  same props. Merge the forwarded ref with an internal ref. Run
  `handleKeyDown` before `props.onKeyDown` and skip the latter if it returns
  true. Spread `fieldProps`. Render `<>{input}{suggestions}</>`.
- `EmojiTextarea.tsx`: the same around `ui/Textarea`.
- `index.ts`: export `EmojiInput`, `EmojiTextarea`, `useEmojiAutocomplete`.

Then extend `src/hooks/useInlineRename.ts` with an optional third argument
`{ emoji?: boolean }`. When it is set, call `useEmojiAutocomplete(inputRef, { enabled: editing })`.
Fold `handleKeyDown` into `inputProps.onKeyDown`: if it consumed the key,
return before the Enter/Escape handling, but keep `stopPropagation`. Spread
`fieldProps` into `inputProps`, composing `onBlur` so a blur still commits.
Return `suggestions` (null when disabled). Update the doc comment.

Update `.claude/rules/ui-components.md` with the bullet from the ADR "Rule"
section.

Manually verify in the running app if possible (`pnpm dev`): type `:tad` in
the new folder dialog, arrow and Enter to insert, and check that Escape closes
only the list, not the dialog.

## Files to touch
- `src/components/ui/EmojiAutocomplete/useEmojiAutocomplete.tsx`: new
- `src/components/ui/EmojiAutocomplete/EmojiAutocomplete.module.css`: new
- `src/components/ui/EmojiAutocomplete/EmojiInput.tsx`: new
- `src/components/ui/EmojiAutocomplete/EmojiTextarea.tsx`: new
- `src/components/ui/EmojiAutocomplete/index.ts`: new
- `src/hooks/useInlineRename.ts`: add the `emoji` option
- `.claude/rules/ui-components.md`: add the rule bullet
