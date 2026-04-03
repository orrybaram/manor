---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-035: Fix zoom regression — only terminal zooms, not whole UI

## Context

There are two zoom systems in Manor:

1. **Electron View menu** — uses `webContents.setZoomFactor()` to zoom the entire window. Accelerators: `CmdOrCtrl+=/-/0`. Zoom level is persisted to `zoom-level.json`.
2. **Renderer keybindings** — intercept `Cmd+=/-/0` via `useKeybindingsStore`, call `e.preventDefault()` in `App.tsx:163`, and dispatch `zoomIn()`/`zoomOut()`/`resetZoom()` on the Zustand store, which only change terminal `fontSize` (range 8–32px).

Because the renderer keybinding handler calls `e.preventDefault()` before the Electron menu accelerators fire, the whole-UI zoom never triggers. Only terminal font size changes.

## Decision

Remove the renderer-side zoom keybindings and font-size zoom system entirely. Let Electron's native View menu accelerators handle `Cmd+=/-/0` for whole-UI zoom (which already works and persists).

Specifically:
1. Remove `zoom-in`, `zoom-out`, `zoom-reset` from `KEYBINDING_DEFS` in `src/lib/keybindings.ts`
2. Remove the three zoom handler entries from `App.tsx`
3. Remove `zoomIn`, `zoomOut`, `resetZoom`, `fontSize`, `DEFAULT_FONT_SIZE`, `MIN_FONT_SIZE`, `MAX_FONT_SIZE` from `app-store.ts`
4. Remove the `fontSize` subscription from `useTerminalLifecycle.ts`
5. Remove `fontSize` parameter from `terminalOptions()` in `src/terminal/config.ts`
6. Remove zoom commands from `CommandPalette/useCommands.tsx` and `CommandPalette.tsx`

## Consequences

- **Better**: Zoom affects the entire UI (tabs, sidebar, terminal) consistently
- **Better**: Zoom level is persisted across restarts (already handled by Electron main process)
- **Tradeoff**: Users can no longer zoom just the terminal font independently from the UI. This is acceptable — it matches standard app behavior (VS Code, iTerm2, etc.)
- **Risk**: None significant. Electron's zoom is well-tested and already wired up.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
