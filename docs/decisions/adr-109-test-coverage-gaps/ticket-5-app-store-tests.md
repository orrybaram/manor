---
title: Add tests for app-store.ts core actions
status: in-progress
priority: high
assignee: opus
blocked_by: []
---

# Add tests for app-store.ts core actions

Write `src/store/__tests__/app-store.test.ts` testing the Zustand store's key state transitions.

## Setup pattern

Follow existing store test patterns (see `src/store/__tests__/agent-status-store.test.ts`):

```typescript
import { useAppStore } from "../app-store";

// Mock electronAPI since store calls it for layout persistence
vi.stubGlobal("window", {
  ...globalThis.window,
  electronAPI: {
    loadLayout: vi.fn().mockResolvedValue(null),
    saveLayout: vi.fn(),
    // ... other methods as needed
  },
});

beforeEach(() => {
  // Reset store to known state before each test
  useAppStore.setState({ ... });
});
```

## Test cases (prioritized by risk)

### Tab operations
- `addTab()` creates a new tab in the active panel with a single leaf pane
- `closeTab(tabId)` removes the tab; if it was the only tab, removes the panel
- `selectTab(tabId)` updates `selectedTabId` on the active panel
- `selectNextTab()` / `selectPrevTab()` wraps around
- `selectTabByGlobalIndex(n)` selects the correct tab across panels
- `togglePinTab(tabId)` adds/removes from `pinnedTabIds`
- `reorderTabs(tabIds)` reorders the tabs array

### Pane operations
- `splitPane("horizontal")` splits the focused pane, creating a split node
- `splitPane("vertical")` same but vertical
- `closePane()` removes pane from tree; if last pane in tab, closes tab
- `closePaneById(id)` closes a specific pane
- `reopenClosedPane()` restores from `closedPaneStack` (both pane and tab snapshots)
- `focusPane(id)` updates `focusedPaneId`
- `focusNextPane()` / `focusPrevPane()` cycles through panes

### Panel operations
- `splitPanel("horizontal")` creates a new panel with a split
- `closePanel(panelId)` removes panel, moves focus to sibling
- `moveTabToPanel(tabId, targetPanelId)` moves tab between panels
- `focusNextPanel()` / `focusPrevPanel()` cycles

### Layout restore
- `restoreWorkspaceState()` (internal helper) handles v1 format (flat `tabs` array)
- `restoreWorkspaceState()` handles v2 format (panel tree with `panels` record)
- `restoreWorkspaceState()` returns empty layout when no tabs

### Workspace management
- `setActiveWorkspace(path)` initializes layout if new
- `removeWorkspaceLayout(path)` cleans up

### Metadata tracking
- `setPaneCwd(paneId, cwd)` updates `paneCwd`
- `setPaneAgentStatus(paneId, state)` updates `paneAgentStatus`
- `setPaneContentType(paneId, type)` updates `paneContentType`

### Startup commands
- `setPendingStartupCommand()` / `consumePendingStartupCommand()` — set returns the command, consume returns it once then null

### selectActiveWorkspace selector
- Returns the correct panel when workspace exists
- Returns null when no active workspace
- Returns null when workspace has no layout

## Files to touch
- `src/store/__tests__/app-store.test.ts` — new file

## Notes
- The store uses `crypto.randomUUID()` for IDs — tests should not assert on specific IDs but on structure
- Focus on state transitions (before → action → after), not implementation details
- Use `useAppStore.getState()` to read and `useAppStore.setState()` to set up preconditions
