---
title: Split EmptyState into separate component files
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Split EmptyState into separate component files

Split `src/components/EmptyState.tsx` (4 components) into individual files.

## New files

### `src/components/ManorLogo.tsx`
- Move `ManorLogo` function component here
- Export it as a named export

### `src/components/EmptyStateShell.tsx`
- Move `EmptyStateShell` component and the `ActionItem` interface here
- Import `ManorLogo` from `./ManorLogo`
- Export both `EmptyStateShell` and `ActionItem`

### `src/components/WorkspaceEmptyState.tsx`
- Move `WorkspaceEmptyState` component here
- Import `EmptyStateShell` and `ActionItem` from `./EmptyStateShell`
- Keep all existing imports (stores, hooks, types, lucide icons)

### `src/components/WelcomeEmptyState.tsx`
- Move `WelcomeEmptyState` component here
- Import `EmptyStateShell` and `ActionItem` from `./EmptyStateShell`

### Delete `src/components/EmptyState.tsx`

## Update imports in consumers
- `src/components/LeafPane.tsx` — imports `WorkspaceEmptyState` and `WelcomeEmptyState` from `./EmptyState` → update to import from their new files

## Files to touch
- `src/components/EmptyState.tsx` — delete
- `src/components/ManorLogo.tsx` — create
- `src/components/EmptyStateShell.tsx` — create
- `src/components/WorkspaceEmptyState.tsx` — create
- `src/components/WelcomeEmptyState.tsx` — create
- `src/components/LeafPane.tsx` — update imports
- `src/components/EmptyState.module.css` — no changes, keep as-is
