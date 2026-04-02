---
title: Add PanelNode tree model and store state
status: done
priority: critical
assignee: opus
blocked_by: [1]
---

# Add PanelNode tree model and store state

Introduce the `PanelNode` binary tree and `Panel` type to the store, replacing the flat `WorkspaceTabState` with a tree-based `WorkspaceLayout`.

## Design

### New types in `src/store/panel-tree.ts`

```typescript
export type PanelNode =
  | { type: "leaf"; panelId: string }
  | {
      type: "split";
      direction: SplitDirection;
      ratio: number;
      first: PanelNode;
      second: PanelNode;
    };
```

Utility functions (mirror pane-tree.ts pattern):
- `allPanelIds(node)` — collect all panel IDs
- `hasPanelId(node, id)` — check existence
- `insertPanelSplit(node, targetPanelId, direction, newPanelId)` — split a panel
- `removePanel(node, panelId)` — remove and collapse
- `updatePanelRatio(node, firstPanelId, ratio)` — resize
- `nextPanelId(node, currentId)` / `prevPanelId(node, currentId)` — cycle focus

### Store changes in `src/store/app-store.ts`

Replace:
```typescript
workspaceTabs: Record<string, WorkspaceTabState>
// where WorkspaceTabState = { tabs, selectedTabId, pinnedTabIds }
```

With:
```typescript
interface Panel {
  id: string;
  tabs: Tab[];
  selectedTabId: string;
  pinnedTabIds: string[];
}

interface WorkspaceLayout {
  panelTree: PanelNode;
  panels: Record<string, Panel>;
  activePanelId: string;
}

// In AppState:
workspaceLayouts: Record<string, WorkspaceLayout>;
```

### Migration

- Create a helper `migrateWorkspaceTabsToLayout(tabs: WorkspaceTabState): WorkspaceLayout` that wraps existing tab state into a single-panel layout
- The `selectActiveWorkspace` selector should still work but return from the new structure
- Add a `selectActivePanel(state): Panel | null` selector for the currently focused panel

### New actions

- `splitPanel(direction: SplitDirection)` — split the active panel, moving the active tab to the new panel
- `closePanel(panelId: string)` — close a panel (close all its tabs) and collapse the split
- `focusPanel(panelId: string)` — set the active panel
- `focusNextPanel()` / `focusPrevPanel()` — cycle panel focus
- `updatePanelSplitRatio(firstPanelId: string, ratio: number)` — resize panel split
- `moveTabToPanel(tabId: string, targetPanelId: string)` — move a tab between panels

### Backward compatibility

All existing tab operations (`addTab`, `closeTab`, `selectTab`, etc.) should operate on the **active panel**. The `selectActiveWorkspace` selector can be updated to return the active panel's tab state so existing components don't break.

## Files to touch

- `src/store/panel-tree.ts` — NEW: panel tree model and utilities
- `src/store/app-store.ts` — restructure state, add panel actions, update existing tab actions to scope to active panel
- `src/electron.d.ts` — add `PersistedPanel`, `PersistedWorkspaceLayout`, bump version to 2
- `electron/` — update persistence serialization/deserialization with v1→v2 migration

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-106): add PanelNode tree model and store state"

Do not push.
