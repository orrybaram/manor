---
title: Keybindings + UI affordances for back/forward
status: done
priority: medium
assignee: sonnet
blocked_by: [2]
---

# Keybindings + UI affordances for back/forward

Wire `navigateBack`/`navigateForward` (ticket 2) to keys, mouse buttons, and
optional chrome buttons.

## Keybindings

Add two command definitions to `DEFAULT_KEYBINDINGS` in `src/lib/keybindings.ts`
(after the existing tab/pane entries ~`:73-96`):
- `history-back` — default `Cmd+Ctrl+Left`
- `history-forward` — default `Cmd+Ctrl+Right`

`Cmd+[`/`]` (pane) and `Cmd+Shift+[`/`]` (tab) are already taken — do NOT reuse
them. If `metaCombo(...)` cannot express a Ctrl+Cmd+Arrow combo, extend the combo
helper/`KeyCombo` type minimally to support it (check `src/lib/keybindings.ts`
combo construction and `KeyCombo` shape first).

Register handlers in `App.tsx`'s handler map (`src/App.tsx:382`, dispatched at
`:467-493`):
```ts
"history-back": () => navigateBack(),
"history-forward": () => navigateForward(),
```

## Mouse back/forward buttons

Add a `mouseup`/`mousedown` (or `auxclick`) listener that maps mouse button 3
(back) → `navigateBack()` and button 4 (forward) → `navigateForward()`. Guard so
it does not fire while focus is inside a terminal/webview pane that should handle
it itself, consistent with how `useTerminalHotkeys` scopes input.

## Optional chrome buttons

If there is an obvious host (e.g. StatusBar or a title area), add back/forward
arrow buttons using `<Button>` from `src/components/ui/Button/Button` (per the
ui-components rule — no raw `<button>`), disabled via `canGoBack`/`canGoForward`
from the history store. Wrap in `<Tooltip>` showing the keybinding. If there is no
clean host, skip and note it in the commit.

## Files to touch
- `src/lib/keybindings.ts` — add `history-back` / `history-forward` command defs (and combo-helper extension if needed).
- `src/App.tsx` — register the two handlers; add mouse back/forward listener.
- (optional) a chrome component (e.g. `src/components/statusbar/StatusBar/StatusBar.tsx`) — back/forward `<Button>`s.
