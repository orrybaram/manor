---
title: Create ports/ directory and move port components
status: done
priority: high
assignee: sonnet
blocked_by: [6]
---

# Create ports/ directory and move port components

Move port-related components into `src/components/ports/` and colocate the hook.

## Components to move

Without subdirectory (no CSS):
- `PortBadge.tsx` → `ports/PortBadge.tsx`
- `PortGroup.tsx` → `ports/PortGroup.tsx`
- `PortsList.tsx` → `ports/PortsList.tsx`

Hook to colocate:
- `src/hooks/usePortsData.ts` → `ports/usePortsData.ts`

## Files to touch
- `src/components/ports/` — create directory and move files
- `src/hooks/usePortsData.ts` — move to ports directory
- All files importing these components/hook — update import paths

## Steps
1. Create `src/components/ports/`
2. Move each component to its new location
3. Move `usePortsData.ts` from `src/hooks/`
4. Update ALL import paths across the codebase
5. Run `bun run typecheck` to verify
