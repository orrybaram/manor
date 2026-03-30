---
title: Create workspace-panes/ directory and move pane components
status: done
priority: high
assignee: sonnet
blocked_by: [5]
---

# Create workspace-panes/ directory and move pane components

Move pane/layout components into `src/components/workspace-panes/`. Also move `PaneDragContext` from `src/contexts/`.

## Components to move

With subdirectory (has CSS):
- `BrowserPane.tsx` + `BrowserPane.module.css` → `workspace-panes/BrowserPane/BrowserPane.tsx` + `BrowserPane.module.css`
- `PaneLayout.tsx` + `PaneLayout.module.css` → `workspace-panes/PaneLayout/PaneLayout.tsx` + `PaneLayout.module.css`
- `TerminalPane.tsx` + `TerminalPane.module.css` → `workspace-panes/TerminalPane/TerminalPane.tsx` + `TerminalPane.module.css`

Without subdirectory (no CSS):
- `LeafPane.tsx` → `workspace-panes/LeafPane.tsx`
- `PaneDropZone.tsx` → `workspace-panes/PaneDropZone.tsx`
- `SplitLayout.tsx` → `workspace-panes/SplitLayout.tsx`

Context file:
- `src/contexts/PaneDragContext.tsx` → `workspace-panes/PaneDragContext.tsx`

## Files to touch
- `src/components/workspace-panes/` — create directory and move files
- `src/contexts/PaneDragContext.tsx` — move to workspace-panes
- All files importing these components — update import paths
- Delete `src/contexts/` directory if empty after move

## Steps
1. Create `src/components/workspace-panes/` and subdirectories
2. Move each component to its new location
3. Move `PaneDragContext.tsx` from `src/contexts/`
4. Update ALL import paths across the codebase
5. Remove empty `src/contexts/` directory
6. Run `bun run typecheck` to verify
