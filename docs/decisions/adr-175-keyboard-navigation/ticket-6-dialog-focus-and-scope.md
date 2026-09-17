---
title: Dialog focus restore, shortcut scope behind modals, focus-visible styles, labels
status: in-progress
priority: high
assignee: sonnet
blocked_by: [2]
---

# Dialog focus restore, shortcut scope behind modals, focus-visible styles, labels

1. New hook `src/hooks/useRestoreFocus.ts`: on open, remember
   `document.activeElement`; on close, focus it if still connected and not
   `body`, else `useAppStore.getState().refocusActivePane()`. Replace the
   hard-coded `.xterm-helper-textarea` refocus in `SettingsModal.tsx:170`,
   `AgentsView.tsx:231`, `CommandPalette.tsx:248`, and apply to the new
   workspace dialog. Palette opening Settings (chained dialogs) must restore
   to the original origin, not to the palette input.
2. `dispatchKeybinding` (`src/lib/keybinding-commands.ts`): if a modal dialog
   is open (`document.querySelector('[role="dialog"][data-state="open"][aria-modal="true"], [role="dialog"][data-state="open"]')`
   — check what Radix renders), only allow `settings` when the open dialog is
   the settings modal, and `command-palette` when the open dialog is the
   palette (so the toggle closes it). Everything else returns without
   handling. Unit test.
3. Global fallback in `src/App.css`:
   `:where(button, [role="button"], [role="tab"], a, [tabindex]):focus-visible { outline: 2px solid var(--<accent token>); outline-offset: 2px; }`
   — find the accent CSS variable used by Switch/Checkbox focus styles.
   Give `ui/Button/Button.module.css` an explicit `:focus-visible` style.
   Audit the `outline: none` rules (grep) — keep them for `:focus` but make
   sure a `:focus-visible` replacement exists for interactive elements
   (inputs can use their border highlight; that counts as visible only if
   box-shadow/outline — prefer a box-shadow ring).
4. Invisible-until-hover buttons (`AgentsView.module.css:198`,
   `FileList.module.css:183`, `TabBar.module.css:186`): also visible on
   `:focus-visible` and on parent `:focus-within`.
5. `aria-label`s on icon-only buttons: `SettingsModal.tsx:180` ("Close
   settings"), `AgentsView.tsx:259` ("Close"), `ProjectSettingsPage.tsx:409`
   ("Delete command"), `LeafPane.tsx:484-512` pane header buttons (use the
   existing title text).
6. Settings nav (`SettingsModal.tsx`): `data-testid="settings-nav-<id>"` on
   every nav button, `aria-current="page"` on the active one, ↑/↓ moves
   between nav buttons. Choosing a search result focuses the section heading
   (`tabIndex=-1`).

## Files to touch
- `src/hooks/useRestoreFocus.ts` (new)
- `src/components/settings/SettingsModal.tsx`, `ProjectSettingsPage.tsx`
- `src/components/command-palette/CommandPalette.tsx`, `AgentsView.tsx`, new-workspace dialog
- `src/lib/keybinding-commands.ts` + test
- `src/App.css`, `src/components/ui/Button/Button.module.css`, listed `.module.css` files
- `src/components/workspace-panes/LeafPane.tsx`
