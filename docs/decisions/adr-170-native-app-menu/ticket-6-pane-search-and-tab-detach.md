---
title: Pane search responds to Edit › Find, and TabBar uses the shared detachTabToNewWindow
status: done
priority: high
assignee: sonnet
blocked_by: [4]
---

# Pane search from the menu, and tab detach reuse

## Steps

1. Pane search. Each pane type already opens its own search on ⌘F. Make each also respond to `requestUi({ type: "pane-search", paneId })` when `paneId` is its own:
   - Terminal: `src/hooks/useTerminalHotkeys.ts:52` matches the `terminal-search` binding and opens the search addon UI. Extract the "open search" branch into a function the hook exposes (or accept an `onOpenSearch` from the pane) and subscribe with `onUiRequest` in the terminal pane component that owns the search UI.
   - Browser: find where `browser-find` is handled in `src/components/workspace-panes/BrowserPane/` and call the same open-find routine.
   - Diff: `src/components/workspace-panes/DiffPane/DiffPane.tsx:125` handles ⌘F; extract the open-search call and subscribe.
   Each subscription lives in a `useEffect` keyed on the pane id and unsubscribes on unmount.
2. Tab detach. Ticket 4 added `detachTabToNewWindow(tabId)` to `src/lib/window-handoff.ts` by moving the payload + spawn-bounds + `window.detachTab` sequence out of `TabBar.tsx`. Switch every call site in `src/components/tabbar/TabBar/` (`:312`, `:531`, `:539` in the pre-change file) to the shared function, passing whatever spawn-bounds the drag path already computed (extend the function signature with an optional `spawnBounds` if the drag path needs its own). Remove the duplicated logic. Existing tests in `src/lib/__tests__/window-handoff.test.ts` must pass; add one for `detachTabToNewWindow` that asserts `window.electronAPI.window.detachTab` is called with the tab payload and that `trackHandoff` is engaged (mirror the `movePaneToNewWindow` test).
3. Manual smoke: with a terminal, a browser, and a diff pane focused in turn, Edit › Find… opens the correct search. Window › Move Tab to New Window pops the active tab out; drag-detach still works.
4. Run renderer `tsc`, `npx vitest run src`, `pnpm lint` on touched files.

## Files to touch
- `src/hooks/useTerminalHotkeys.ts` and the terminal pane component that owns search — subscribe for `pane-search`
- `src/components/workspace-panes/BrowserPane/BrowserPane.tsx` — subscribe for `pane-search`
- `src/components/workspace-panes/DiffPane/DiffPane.tsx` — subscribe for `pane-search`
- `src/components/tabbar/TabBar/TabBar.tsx` — call `detachTabToNewWindow`
- `src/lib/window-handoff.ts` — optional `spawnBounds` param if needed
- `src/lib/__tests__/window-handoff.test.ts` — new case
