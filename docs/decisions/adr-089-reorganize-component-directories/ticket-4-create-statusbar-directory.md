---
title: Create statusbar/ directory and move statusbar components
status: done
priority: high
assignee: sonnet
blocked_by: [3]
---

# Create statusbar/ directory and move statusbar components

Move statusbar-related components into `src/components/statusbar/`.

## Components to move

All have CSS (get subdirectories):
- `StatusBar.tsx` + `StatusBar.module.css` → `statusbar/StatusBar/StatusBar.tsx` + `StatusBar.module.css`
- `AboutModal.tsx` + `AboutModal.module.css` → `statusbar/AboutModal/AboutModal.tsx` + `AboutModal.module.css`
- `LinkedIssuesPopover.tsx` + `LinkedIssuesPopover.module.css` → `statusbar/LinkedIssuesPopover/LinkedIssuesPopover.tsx` + `LinkedIssuesPopover.module.css`

## Files to touch
- `src/components/statusbar/` — create directory and move files
- All files importing these components — update import paths

## Steps
1. Create `src/components/statusbar/` and subdirectories
2. Move each component to its new location
3. Update ALL import paths across the codebase
4. Run `bun run typecheck` to verify
