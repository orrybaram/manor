---
title: Tab and pane commands over the app-command bridge
status: in-progress
priority: high
assignee: sonnet
blocked_by: []
---

# Tab and pane commands over the app-command bridge

Renderer-owned layout state. Read `src/lib/app-commands.ts` top to bottom first: its header explains why handlers validate before writing and throw on bad input. Follow `splitPane`/`focusPane` there and `paneRoutes` in `electron/routes/panes.ts`.

## Renderer handlers (`src/lib/app-commands.ts`, add to `appCommandHandlers`)

| Command | Args | Store action |
|---|---|---|
| `select-tab` | `tabId` | `selectTab` |
| `next-tab` / `prev-tab` | — | `selectNextTab` / `selectPrevTab` |
| `close-tab` | `tabId` | `closeTab` (not `requestCloseTab`; no confirm dialog over HTTP — say so in the tool description) |
| `close-other-tabs` / `close-tabs-to-right` | `tabId` | same-named actions |
| `pin-tab` | `tabId` | `togglePinTab` (return the new pinned state) |
| `duplicate-tab` | `tabId` | `duplicateTab` (return new tab id) |
| `reorder-tabs` | `tabIds: string[]` | `reorderTabs` (validate same set as current) |
| `open-diff` | — | `openOrFocusDiff` (return tab id) |
| `set-pane-title` / `clear-pane-title` | `paneId`, `title` | `setPaneTitle` / `clearPaneTitle` |
| `move-pane` | per `movePaneToTarget` signature | `movePaneToTarget` |
| `extract-pane-to-tab` | `paneId`, `targetPanelId?` | `extractPaneToTab` |
| `reopen-closed-pane` | — | `reopenClosedPane` (error if nothing to reopen) |
| `focus-next-pane` / `focus-prev-pane` | — | same-named |
| `set-active-workspace` | `workspacePath` | `setActiveWorkspace` (validate the path is a known workspace via `useProjectStore`) |

Every handler validates ids exist (`hasPaneId`, tab lookup) and throws with a message naming the id.

## Routes (`electron/routes/panes.ts`, `tabRoutes` / `paneRoutes`)

`POST /tabs/:tabId/select|close|close-others|close-right|pin|duplicate`, `POST /tabs/next`, `POST /tabs/prev`, `POST /tabs/reorder`, `POST /tabs/diff`, `POST /panes/:paneId/title` (body `{ title }` or `{ title: null }` to clear), `POST /panes/:paneId/move`, `POST /panes/:paneId/extract`, `POST /panes/reopen`, `POST /panes/focus-next`, `POST /panes/focus-prev`, `POST /workspaces/active` (body `{ workspacePath }`). Static segments (`next`, `prev`, `reorder`, `diff`, `reopen`, `focus-next`, `focus-prev`) go **before** the `:tabId`/`:paneId` rows of the same length and method. `router.test.ts` checks this.

## Tools (`electron/mcp/tools-panes.ts`)

One per command, `select_tab`, `close_tab`, … `set_active_workspace`. `workspacePath` defaults via `resolveWorkspacePath`.

## Tests
- `src/lib/__tests__/app-commands.test.ts`: extend with select/close/pin/reorder/set-pane-title/set-active-workspace, including the throw paths.
- `electron/routes/router.test.ts` passes.

## Files to touch
- `src/lib/app-commands.ts`
- `src/lib/__tests__/app-commands.test.ts`
- `electron/routes/panes.ts`
- `electron/mcp/tools-panes.ts`
- `electron/mcp/tools-panes.test.ts` — extend
