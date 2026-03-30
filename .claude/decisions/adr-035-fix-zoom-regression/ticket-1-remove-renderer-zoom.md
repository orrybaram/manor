---
title: Remove renderer-side zoom system
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Remove renderer-side zoom system

Remove the renderer-side zoom keybindings and font-size-only zoom logic so that Electron's native View menu accelerators handle whole-UI zoom.

## Files to touch

- `src/lib/keybindings.ts` — Remove the three `zoom-in`, `zoom-out`, `zoom-reset` entries from `KEYBINDING_DEFS` array (lines ~122-139)
- `src/App.tsx` — Remove the `zoomIn`/`zoomOut`/`resetZoom` store selectors (lines ~103-105) and the three zoom handler entries from `handlersRef.current` (lines ~137-139)
- `src/store/app-store.ts` — Remove `fontSize` from state (line ~120, ~157), remove `DEFAULT_FONT_SIZE`/`MIN_FONT_SIZE`/`MAX_FONT_SIZE` constants (lines ~144-146), remove `zoomIn`/`zoomOut`/`resetZoom` methods (lines ~606-610). Also remove `fontSize` from the AppState type.
- `src/hooks/useTerminalLifecycle.ts` — Remove the `fontSize` subscription that updates xterm's fontSize option (lines ~66-77), remove fontSize from terminal initialization (line ~99)
- `src/terminal/config.ts` — Remove `fontSize` parameter from `terminalOptions()` function, use a hardcoded default font size (13) instead
- `src/components/CommandPalette/useCommands.tsx` — Remove the three zoom commands (lines ~144-169)
- `src/components/CommandPalette/CommandPalette.tsx` — Remove `zoomIn`/`zoomOut`/`resetZoom` store extraction (lines ~48-50) and the props passed to `useCommands`
