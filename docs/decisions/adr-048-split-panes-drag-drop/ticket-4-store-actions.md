---
title: Add store actions for positional split and pane move
status: done
priority: critical
assignee: sonnet
blocked_by: [1]
---

# Add store actions for positional split and pane move

Add new Zustand store actions that the drop zone component will call to create splits at specific positions and move panes between locations.

## Implementation

Add these actions to `AppState` interface and implement them in `app-store.ts`:

### `splitPaneAt(targetPaneId, direction, position)`

Creates a new terminal pane at a specific position relative to the target pane. Used when dropping a tab onto a pane (creating a brand new terminal in the split).

```typescript
splitPaneAt: (targetPaneId: string, direction: SplitDirection, position: "first" | "second") => void;
```

Implementation:
1. Find which session contains `targetPaneId`
2. Generate a new pane ID
3. Call `insertSplitAt(session.rootNode, targetPaneId, direction, newPaneId, position)`
4. Update session's rootNode and set focusedPaneId to the new pane

### `movePaneToTarget(sourcePaneId, targetPaneId, direction, position)`

Moves an existing pane to a new position relative to a target pane. Handles same-session and cross-session moves.

```typescript
movePaneToTarget: (sourcePaneId: string, targetPaneId: string, direction: SplitDirection, position: "first" | "second") => void;
```

Implementation:
1. Find which session contains `sourcePaneId` and which contains `targetPaneId`
2. **Same session:** Use `movePane()` from pane-tree on the session's rootNode
3. **Cross-session:**
   - Remove source pane from source session (using `removePane`)
   - If source session is now empty (removePane returned null), close the source session
   - Insert source pane into target session (using `insertSplitAt` with `sourcePaneId`)
4. Set focus to the moved pane
5. Preserve `paneCwd`, `paneTitle`, and `paneAgentStatus` for the moved pane (they're keyed by paneId which doesn't change)

### `moveSessionToPane(sessionId, targetPaneId, direction, position)`

Takes a full session (tab) and moves its root pane tree content into a split at the target. Used when dragging a tab onto a pane.

```typescript
moveSessionToPane: (sessionId: string, targetPaneId: string, direction: SplitDirection, position: "first" | "second") => void;
```

Implementation:
1. Find the source session by ID
2. If source session has a single leaf pane, use `movePaneToTarget` logic
3. If source session has multiple panes (a tree), insert the entire subtree — replace the target leaf with a split where one child is the target leaf and the other is the source session's root node
4. Remove the source session
5. Focus the first pane from the moved content

For case 3, add a helper to `pane-tree.ts`:

```typescript
export function insertSubtreeAt(
  node: PaneNode,
  targetPaneId: string,
  direction: SplitDirection,
  subtree: PaneNode,
  position: "first" | "second",
): PaneNode
```

## Files to touch
- `src/store/app-store.ts` — Add `splitPaneAt`, `movePaneToTarget`, `moveSessionToPane` actions
- `src/store/pane-tree.ts` — Add `insertSubtreeAt` helper if needed for multi-pane session moves
