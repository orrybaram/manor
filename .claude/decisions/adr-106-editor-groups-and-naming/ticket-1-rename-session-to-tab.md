---
title: Rename Session to Tab throughout codebase
status: todo
priority: critical
assignee: opus
blocked_by: []
---

# Rename Session to Tab throughout codebase

Mechanical rename of the `Session` concept to `Tab` across the entire codebase. This establishes the new naming convention before adding panel functionality.

## Naming map

| Old | New |
|-----|-----|
| `Session` (interface) | `Tab` |
| `session` / `sessions` (variables) | `tab` / `tabs` |
| `sessionId` / `selectedSessionId` | `tabId` / `selectedTabId` |
| `pinnedSessionIds` | `pinnedTabIds` |
| `WorkspaceSessionState` | `WorkspaceTabState` |
| `workspaceSessions` | `workspaceTabs` |
| `createSession()` | `createTab()` |
| `newSessionId()` | `newTabId()` |
| `addSession` / `closeSession` / `selectSession` | `addTab` / `closeTab` / `selectTab` |
| `addBrowserSession` / `addDiffSession` | `addBrowserTab` / `addDiffTab` |
| `selectNextSession` / `selectPrevSession` | `selectNextTab` / `selectPrevTab` |
| `reorderSessions` | `reorderTabs` |
| `togglePinSession` | `togglePinTab` |
| `requestCloseSession` | `requestCloseTab` |
| `pendingCloseConfirmSessionId` | `pendingCloseConfirmTabId` |
| `setPendingCloseConfirmSessionId` | `setPendingCloseConfirmTabId` |
| `extractPaneToSession` | `extractPaneToTab` |
| `moveSessionToPane` | `moveTabToPane` |
| `openOrFocusDiff` | `openOrFocusDiff` (unchanged — no "session" in name) |
| `SessionButton` component | `TabButton` |
| `SessionLayout` | `TabLayout` |
| `PersistedSession` | `PersistedTab` |
| CSS classes with `session` | rename to `tab` |
| Keybinding IDs: `select-session-N` | `select-tab-N` |
| Keybinding IDs: `next-session` / `prev-session` | `next-tab` / `prev-tab` |

## Important: preserve "Tab" in UI labels

The UI already shows "Tab" in labels (e.g., "New Tab", "Close Tab", "Pin Tab"). These are correct and should remain unchanged.

## Files to touch

- `src/store/app-store.ts` — rename interfaces, state fields, action names
- `src/App.tsx` — update all references to session store fields and actions
- `src/components/tabbar/TabBar/TabBar.tsx` — update store references
- `src/components/tabbar/SessionButton.tsx` — rename file to `TabButton.tsx`, rename component
- `src/components/tabbar/TabBar/TabBar.module.css` — rename `.session*` classes to `.tab*`
- `src/components/workspace-panes/PaneDragContext.tsx` — rename `sessionId` in `DragPayload`
- `src/components/workspace-panes/PaneDropZone.tsx` — update references
- `src/components/workspace-panes/LeafPane.tsx` — update store action references
- `src/electron.d.ts` — rename `PersistedSession` to `PersistedTab`
- `src/components/command-palette/` — update any session references in command IDs
- `src/store/keybindings-store.ts` — update command IDs
- `electron/` — update any session references in main process (persistence, IPC)
- Any other files that reference `Session` or `session` in the context of tabs

## Approach

1. Start with types/interfaces in `app-store.ts` and `electron.d.ts`
2. Update the store implementation (action names, state fields)
3. Update all consumers (components, other stores)
4. Rename the `SessionButton` file and component
5. Update CSS class names
6. Update keybinding command IDs
7. Ensure the app compiles with `npm run typecheck`

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-106): rename Session to Tab throughout codebase"

Do not push.
