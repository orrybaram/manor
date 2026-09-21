---
title: One command table drives keybindings, menu, palette and web filter
status: in-progress
priority: medium
assignee: opus
blocked_by: [10]
---

# One command table drives keybindings, menu, palette and web filter

ADR-182 D10.

## Problem
A command id lives in about 7 hand-synced places:
- `DEFAULT_KEYBINDINGS` (`src/lib/keybinding-defs.ts`)
- `SHARED_WINDOW_COMMANDS`, `MAIN_WINDOW_KEYBINDINGS` and `NATIVE_ONLY_COMMANDS` (`src/lib/menu-commands.ts`)
- `createSharedKeybindingHandlers` (`src/lib/keybinding-commands.ts`)
- `createMenuHandlers` (`src/lib/menu-handlers.ts`)
- the palette's `CommandItem` list (`src/components/command-palette/useCommands.tsx`)
- the menu template

Consequences:
- **Triplicated logic.** "Move tab to next panel" exists three times: `keybinding-commands.ts:~191`, `useCommands.tsx:~335`, `TabButton.tsx:~344`.
- **Drift.** The palette's `close-tab` skips the confirmation that `requestCloseTab` shows.
- **Web filter applied three times:** `useCommands.tsx:~619`, `keybinding-commands.ts:~149`, `menu-handlers.ts:~183`.

## Change
- **The table.** Create `src/lib/commands.ts` exporting `COMMANDS: CommandDef[]`, with `{ id, label, category, defaultCombo?, scope: "any" | "primary", native?: true, run(ctx) }`.
- **Derived lists.** Derive `DEFAULT_KEYBINDINGS`, `SHARED_WINDOW_COMMANDS`, `MAIN_WINDOW_KEYBINDINGS` and `NATIVE_ONLY_COMMANDS` from it. Keep the exported names if many importers use them.
- **Handlers.** The keybinding and menu handler maps become `dispatch(id)` over the table.
- **Palette.** The palette renders static items from the table as `{ ...meta, action: () => dispatch(id) }` and adds only its dynamic extras (ports, settings pages, and so on).
- **Web filter.** Apply the native-only / web filter once, at the table. Base it on `UNAVAILABLE_NAMESPACES` in `src/bridge/unavailable.ts` wherever a command's native-ness comes from a namespace.
- **Help links.** The help-link handlers in `menu-handlers.ts:~352-359` use `openExternal` from `src/lib/open-external.ts`, so they stop being native-only. Delete their `NATIVE_ONLY_COMMANDS` entries.
- **Move tab.** One `moveTabToNextPanel()` helper, used by the table and by `TabButton`.

## Tests
Update the existing tests: `app-commands.test.ts`, the menu/keybinding tests, and the test that checks the lists stay in sync (it may become unnecessary; delete it if so).

## Files to touch
- `src/lib/commands.ts` (new), `src/lib/keybinding-defs.ts`, `src/lib/keybinding-commands.ts`, `src/lib/menu-commands.ts`, `src/lib/menu-handlers.ts`, `src/lib/app-commands.ts`
- `src/components/command-palette/useCommands.tsx`, `src/components/tabbar/TabButton.tsx`, `src/App.tsx` (the OWN_CLAIM filter ~500-520), and the tests
