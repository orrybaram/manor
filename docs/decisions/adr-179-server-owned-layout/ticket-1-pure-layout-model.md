---
title: One pure layout model in src/lib/layout, with a command reducer
status: done
priority: critical
assignee: opus
blocked_by: []
---

# One pure layout model in src/lib/layout, with a command reducer

ADR-179 D2. Behaviour of the desktop is **unchanged** by this ticket: the
store keeps owning the layout; it just calls a pure reducer instead of
mutating inline. This is the ticket that makes the next one possible.

## Move

- `src/store/pane-tree.ts` → `src/lib/layout/pane-tree.ts`;
  `src/store/panel-tree.ts` → `src/lib/layout/panel-tree.ts`; their tests
  alongside. Leave one-line re-exports at the old paths for now (delete them
  in ticket 3 once nothing imports them; knip will tell you).
- `WorkspaceLayout`, `Panel`, `Tab` types (currently `app-store.ts:89-117`)
  → `src/lib/layout/workspace-layout.ts`. `Tab.focusedPaneId`,
  `Panel.selectedTabId` and `WorkspaceLayout.activePanelId` **stay** in the
  structural types for this ticket (ticket 4 moves them to viewport); mark
  them `/** viewport — moves in ADR-179 ticket 4 */`.
- `electron/terminal-host/layout-persistence.ts` — delete the duplicated
  `PaneNode`/`PanelNode` types and import from `src/lib/layout/`. The
  "cannot import from the renderer bundle" comment is wrong; `electron/`
  already imports `src/lib/` (see `electron/app-menu.ts`). Confirm
  `pnpm build` still bundles the terminal-host entry.

## The reducer

`src/lib/layout/commands.ts`:

```ts
export type LayoutCommand =
  | { type: "new-tab"; tab: Tab; panelId?: string; select?: boolean }
  | { type: "close-tab"; tabId: string }
  | { type: "duplicate-tab"; tabId: string; newTab: Tab }
  | { type: "close-other-tabs"; tabId: string }
  | { type: "close-tabs-to-right"; tabId: string }
  | { type: "reorder-tabs"; panelId: string; tabIds: string[] }
  | { type: "toggle-pin-tab"; tabId: string }
  | { type: "split-pane"; paneId: string; direction: SplitDirection; newPaneId: string; contentType?: ...; url?: string }
  | { type: "split-pane-at"; ... }          // mirror splitPaneAt's args
  | { type: "move-pane"; ... }              // movePaneToTarget
  | { type: "move-tab-to-pane"; ... }
  | { type: "extract-pane-to-tab"; paneId: string; targetPanelId?: string; newTabId: string }
  | { type: "close-pane"; paneId: string }
  | { type: "reopen-closed-pane" }
  | { type: "set-pane-title"; paneId: string; title: string | null }
  | { type: "set-pane-content-type"; paneId: string; contentType: ...; url?: string }
  | { type: "split-panel"; panelId: string; direction: SplitDirection; newPanelId: string }
  | { type: "close-panel"; panelId: string }
  | { type: "update-panel-ratio"; firstPanelId: string; ratio: number }
  | { type: "move-tab-to-panel"; tabId: string; targetPanelId: string }
  | { type: "split-panel-with-tab"; tabId: string; targetPanelId: string; direction: SplitDirection; newPanelId: string }
  | { type: "update-split-ratio"; firstPaneId: string; ratio: number };

export interface LayoutEffects {
  /** Terminal panes that left the tree; the host ends their sessions. */
  killPanes: string[];
  /** Panes that left the tree but must stay alive (moved, extracted). */
  releasedPanes: string[];
}

export function applyLayoutCommand(
  state: { layout: WorkspaceLayout; closedStack: ClosedPane[] },
  command: LayoutCommand,
): { layout: WorkspaceLayout; closedStack: ClosedPane[]; effects: LayoutEffects };
```

Rules:
- **Ids come in the command.** Every action that today calls
  `newPaneId()`/`newTabId()`/`newPanelId()` inside the store generates the id
  *before* building the command and passes it. The reducer never calls
  `crypto.randomUUID`. (The server will run this reducer; ids must be
  decidable by the sender so it can focus the new pane when the broadcast
  lands.)
- **"Current" is resolved by the sender.** `splitPane(direction)` in the store
  reads its own focused pane and sends `{ type: "split-pane", paneId }`.
  Nothing in the reducer reads `focusedPaneId`/`selectedTabId`/`activePanelId`
  to *decide* anything; it may *update* them for now (they still live in the
  structural type until ticket 4).
- Pure: no `set()`, no `window.electronAPI`, no side maps. Everything the
  actions do to `paneCwd`/`paneTitle`/`paneContentType`/pty create/close/
  confirmation dialogs stays in the store, before or after the reducer call.
- The closed-pane stack that `reopenClosedPane` reads is part of the reducer
  state (`closedStack`), so it can move to the server in ticket 2.
- A command that names an id not in the tree returns the state unchanged with
  empty effects. Not a throw — a stale command from a slow renderer is normal.

Refactor each of the ~25 store actions to: build command → call
`applyLayoutCommand` → `set()` the result → run side effects from `effects`
(`killPanes` → `window.electronAPI.pty.close`, as the action did inline). Keep
every existing store test green; they are the behaviour spec
(`app-store.test.ts`, `app-store-split-pane-at.test.ts`,
`app-store-close-pane-abandon.test.ts`, `app-store-add-browser-tab.test.ts`,
`app-store-pane-scope.test.ts`).

## Tests

- `src/lib/layout/__tests__/commands.test.ts` — one describe per command
  type, plus: unknown id is a no-op; `close-pane` on a terminal pane reports
  `killPanes`; `move-pane` reports `releasedPanes` not `killPanes`; the reducer
  is deterministic (same input twice, deep-equal output); no `randomUUID`
  reachable (spy).
- Existing store tests unchanged and green.

## Files to touch
- `src/lib/layout/{pane-tree,panel-tree,workspace-layout,commands}.ts` and `__tests__/` — new home
- `src/store/pane-tree.ts`, `src/store/panel-tree.ts` — re-export shims
- `src/store/app-store.ts` — actions call the reducer; ids generated before the command
- `src/store/layout-snapshot.ts`, `src/store/detach-types.ts` — import paths
- `electron/terminal-host/layout-persistence.ts` — import types, delete duplicates
- `knip.json` — only if the move confuses it
