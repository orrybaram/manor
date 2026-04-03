---
type: adr
status: proposed
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

# ADR-106: Editor Groups with Unified Naming Convention

## Context

Manor currently supports splitting panes within a single tab (session), but there's no way to split the main content area into side-by-side groups — each with their own tab bar — like VS Code's editor groups. The current naming is also inconsistent: "Session", "Tab", and "Pane" are used interchangeably across the codebase, and a new concept (the container that holds tabs) needs a clear name.

### Current Architecture

- **`Session`** — a named entity containing a `PaneNode` tree and a focused pane ID. Rendered as a tab in the tab bar.
- **`PaneNode`** — a binary tree of `leaf` (terminal/browser/diff) and `split` nodes within a session.
- **`WorkspaceSessionState`** — holds `sessions[]`, `selectedSessionId`, `pinnedSessionIds` for a workspace.
- One tab bar at the top, one selected session visible at a time.

### Problem

1. Users can split panes within a tab, but cannot have two tabs visible simultaneously side-by-side (like VS Code editor groups).
2. Terminology is muddled — the UI says "Tab" but code says "Session"; "Pane" means both a leaf terminal and a generic content area.

## Decision

### Naming Convention

Establish a clear hierarchy with these terms:

| Term | Definition | Code identifier | UI label |
|------|-----------|----------------|----------|
| **Panel** | A top-level split region of the main content area. Each panel has its own tab bar and set of tabs. Analogous to VS Code "editor group". | `Panel` | (implicit — users see it as a split region) |
| **Tab** | A named content unit within a panel, containing a pane tree. Currently called `Session` in code. | `Tab` (rename from `Session`) | "Tab" |
| **Pane** | A leaf content area (terminal, browser, diff) within a tab's split layout. | `PaneNode` (unchanged) | "Pane" |

### Architecture

Introduce a new `PanelNode` tree (similar to `PaneNode` but at a higher level) that splits the main content area into panels:

```typescript
// New: top-level layout tree for panels
export type PanelNode =
  | { type: "leaf"; panelId: string }
  | {
      type: "split";
      direction: SplitDirection;
      ratio: number;
      first: PanelNode;
      second: PanelNode;
    };

// Renamed from WorkspaceSessionState
interface Panel {
  id: string;            // panelId
  tabs: Tab[];           // renamed from sessions
  selectedTabId: string; // renamed from selectedSessionId
  pinnedTabIds: string[];// renamed from pinnedSessionIds
}

// Renamed from Session
interface Tab {
  id: string;
  title: string;
  rootNode: PaneNode;
  focusedPaneId: string;
}

// New: workspace-level layout
interface WorkspaceLayout {
  panelTree: PanelNode;                    // tree of panel splits
  panels: Record<string, Panel>;           // panelId -> Panel
}
```

**How it renders** (App.tsx main content area):

```
.main-content
  PanelLayout (recursive, like PaneLayout)
    ├─ LeafPanel (if panelNode.type === "leaf")
    │   ├─ TabBar (scoped to this panel's tabs)
    │   └─ .terminal-container (selected tab's PaneLayout)
    │
    └─ SplitPanelLayout (if panelNode.type === "split")
        ├─ PanelLayout (first)
        ├─ .divider (resizable)
        └─ PanelLayout (second)
```

### Splitting Panels

- New keybinding/command: "Split Panel Right" / "Split Panel Down"
- Splits the current panel, moving the active tab to the new panel (or keeping a copy)
- Dragging a tab to the edge of the content area creates a new panel
- When a panel's last tab is closed, the panel is removed and the split collapses

### Migration Strategy

**Rename in one pass**: `Session` -> `Tab` everywhere (types, store fields, component props, CSS classes). This is a mechanical rename — no behavioral changes.

**Then add panels**: The current `WorkspaceSessionState` effectively becomes a single `Panel`. The new `WorkspaceLayout` wraps it with a `PanelNode` tree, starting with a single leaf panel (backward compatible).

**Persistence**: Bump `PersistedLayout` to `version: 2`. Migration from v1: wrap existing sessions into a single panel with a single-leaf panel tree.

## Consequences

**Better**:
- Users can view two tabs side-by-side (e.g., terminal + browser, two terminals)
- Clear, consistent naming throughout codebase and UI
- Panel tree reuses the same binary tree pattern as pane splits, keeping the architecture familiar

**Harder**:
- Large rename touches many files (but is mechanical and safe)
- Focus management becomes more complex — need to track which panel is active as well as which pane
- Drag-and-drop needs to handle cross-panel tab moves and panel-edge drops
- Persistence migration needed for existing layouts

**Risks**:
- The rename is wide-reaching — must be thorough to avoid half-renamed state
- Panel focus + pane focus interaction needs careful design to avoid confusing keyboard navigation

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
