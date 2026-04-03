---
title: Create ui/ directory and move shared primitives
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Create ui/ directory and move shared primitives

Move shared UI primitives into `src/components/ui/`. Components with `.module.css` get their own subdirectory.

## Components to move

With subdirectory (has CSS):
- `AgentDot.tsx` + `AgentDot.module.css` → `ui/AgentDot/AgentDot.tsx` + `AgentDot.module.css`
- `EmptyState.tsx` + `EmptyState.module.css` → `ui/EmptyState/EmptyState.tsx` + `EmptyState.module.css`
- `SpinnerLoader.tsx` + `SpinnerLoader.module.css` → `ui/SpinnerLoader/SpinnerLoader.tsx` + `SpinnerLoader.module.css`
- `Switch.tsx` + `Switch.module.css` → `ui/Switch/Switch.tsx` + `Switch.module.css`
- `Toast.tsx` + `Toast.module.css` → `ui/Toast/Toast.tsx` + `Toast.module.css`
- `Tooltip.tsx` + `Tooltip.module.css` → `ui/Tooltip/Tooltip.tsx` + `Tooltip.module.css`

Without subdirectory (no CSS):
- `ManorLogo.tsx` → `ui/ManorLogo.tsx`
- `ToastItem.tsx` → `ui/ToastItem.tsx`

## Files to touch
- `src/components/ui/` — create directory and move files
- All files importing these components — update import paths
- Use grep to find all imports before moving

## Steps
1. Create `src/components/ui/` directory
2. Move each component (and CSS if applicable) to its new location
3. Update ALL import paths across the codebase (grep for each component name)
4. Run `bun run typecheck` to verify no broken imports
