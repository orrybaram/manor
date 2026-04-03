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

# ADR-048: Split Panes via Drag-and-Drop with Directional Drop Zones

## Context

Currently, panes can only be split via the split button in the pane status bar, which always creates a horizontal split to the right. There's no way to drag a tab or an existing pane into another pane to create a split in a specific direction (top/bottom/left/right). Users need a more intuitive, visual way to create splits — the standard approach used by VS Code, iTerm2, and other IDEs where you drag content onto directional drop zones overlaid on a pane.

The existing infrastructure supports this well:
- `pane-tree.ts` already has `insertSplit()` which takes a direction and creates a split with the new pane as the `second` child
- Tab drag is already implemented via pointer events in `TabBar.tsx`
- The `PaneLayout` → `LeafPane` → `SplitLayout` rendering pipeline is recursive and well-structured
- The store has `splitPane()`, `closePane()`, `closePaneById()`, and `focusPane()` actions

What's missing is:
1. A way to signal that a drag is happening across the app (drag context)
2. Drop zone overlays on `LeafPane` that respond to drag position
3. A new store action that creates a split with a *specific* new pane ID (for moved panes) or creates a new pane (for tabs creating new sessions)
4. Modifying `insertSplit` to support inserting as `first` (for left/top drops) vs `second` (for right/bottom drops)

## Decision

### Approach: React Context + Pointer Events

Use a React context (`PaneDragContext`) to coordinate drag state across components. This avoids needing a global drag-and-drop library and fits the existing pointer event patterns used in `TabBar.tsx` and `useWorkspaceDrag.ts`.

### Architecture

**1. Drag Context (`src/contexts/PaneDragContext.tsx`)**
- Provides `dragState: { type: 'tab' | 'pane', sourceSessionId?: string, sourcePaneId?: string } | null`
- `startDrag(payload)` / `endDrag()` methods
- All LeafPanes subscribe to this context to show/hide drop zones

**2. Pane tree enhancement (`src/store/pane-tree.ts`)**
- Add `insertSplitAt()` function: like `insertSplit` but accepts a `position: 'first' | 'second'` param to control whether the new pane goes before or after the target
  - `position: 'first'` → new pane becomes `first` child (left/top), existing becomes `second`
  - `position: 'second'` → existing stays as `first`, new pane becomes `second` (right/bottom)
- Add `movePane()`: combines `removePane` + `insertSplitAt` — removes a pane from its current location and inserts it at a target

**3. Drop zone overlay (`src/components/PaneDropZone.tsx`)**
- Rendered inside each `LeafPane` when a drag is active (from context)
- Absolutely positioned overlay covering the full pane
- Divides into 4 quadrants based on pointer position relative to pane center
- Visual: semi-transparent highlight (`var(--accent)` at 20% opacity) covering the half where drop will occur, with a preview divider line
- Uses `onPointerMove` to track which zone is active, `onPointerUp` to handle drop

**4. Store actions (`src/store/app-store.ts`)**
- `splitPaneAt(targetPaneId, direction, position)` — creates a new pane at a specific position relative to target
- `movePaneToTarget(sourcePaneId, targetPaneId, direction, position)` — moves an existing pane (from same or different session) to create a split at target
- `moveSessionToPane(sessionId, targetPaneId, direction, position)` — takes a session's content and splits it into a target pane

**5. Tab drag integration (`src/components/TabBar.tsx` / `SessionButton.tsx`)**
- When a tab drag starts and leaves the tab bar area, set the drag context
- The existing pointer capture approach handles this — extend the `onMove` handler to detect when the pointer exits the tab bar bounds
- On drop into a pane zone: create a split, move the session's pane tree into the new pane position

**6. Pane drag source (`src/components/LeafPane.tsx`)**
- The pane status bar becomes a drag handle
- On pointerdown + movement threshold on the status bar, start a pane drag via context
- Visual: dragged pane gets a subtle opacity reduction

### Drop Zone Mapping

| Pointer Position | Direction | Position | Result |
|---|---|---|---|
| Top half | `vertical` | `first` | New pane above, existing below |
| Bottom half | `vertical` | `second` | Existing above, new pane below |
| Left half | `horizontal` | `first` | New pane left, existing right |
| Right half | `horizontal` | `second` | Existing left, new pane right |

The zone is determined by which edge the pointer is closest to, using the pane's bounding rect.

### Cross-Session Moves

When dragging a tab into a pane that belongs to a different session:
- The tab's session content (all its panes) gets merged into the target session as a split
- The source session/tab is removed

When dragging a single pane into another pane (same session):
- The pane is removed from its current position in the tree and re-inserted at the target
- If the source pane was the only pane, its session closes

## Consequences

**Positive:**
- Intuitive split creation matching user expectations from VS Code/iTerm2
- Builds on existing pointer event patterns — no new dependencies
- The pane tree's immutable update model makes move operations safe (remove then insert)
- Drop zone visuals give clear feedback before committing to a split

**Negative:**
- The drag context adds a new React context that all LeafPanes subscribe to — but it's a single boolean-ish value so re-renders are minimal
- Cross-session pane moves are complex (need to handle PTY lifecycle, metadata transfer)
- Tab-to-pane drag requires coordinating between the tab bar's existing drag system and the new pane drop zones

**Risks:**
- Pointer capture in the tab bar may conflict with the pane drop zones (need to release capture when leaving tab bar)
- Moving panes between sessions needs careful PTY session management to avoid terminal resets

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
