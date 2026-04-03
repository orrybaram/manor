---
title: Create tabbar/ directory and move tabbar components
status: done
priority: high
assignee: sonnet
blocked_by: [4]
---

# Create tabbar/ directory and move tabbar components

Move tabbar-related components into `src/components/tabbar/`.

## Components to move

With subdirectory (has CSS):
- `TabBar.tsx` + `TabBar.module.css` → `tabbar/TabBar/TabBar.tsx` + `TabBar.module.css`
- `Breadcrumbs.tsx` + `Breadcrumbs.module.css` → `tabbar/Breadcrumbs/Breadcrumbs.tsx` + `Breadcrumbs.module.css`

Without subdirectory (no CSS):
- `SessionButton.tsx` → `tabbar/SessionButton.tsx`
- `TabAgentDot.tsx` → `tabbar/TabAgentDot.tsx`

## Files to touch
- `src/components/tabbar/` — create directory and move files
- All files importing these components — update import paths

## Steps
1. Create `src/components/tabbar/` and subdirectories
2. Move each component to its new location
3. Update ALL import paths across the codebase
4. Run `bun run typecheck` to verify
