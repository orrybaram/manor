---
title: Rename CommandPalette/ to command-palette/ and move colocated hooks
status: done
priority: medium
assignee: sonnet
blocked_by: [7]
---

# Rename CommandPalette/ to command-palette/ and move colocated hooks

Rename the existing `CommandPalette/` directory to `command-palette/` for consistency with the other kebab-case feature directories. Also move `useSessionAgentStatus.ts`, `useDebouncedAgentStatus.ts`, and `useSessionTitle.ts` from `src/components/` to `src/hooks/` since they're used by multiple consumers.

## Changes

Directory rename:
- `src/components/CommandPalette/` → `src/components/command-palette/`

Hooks to move to `src/hooks/` (multi-consumer, currently misplaced in components/):
- `src/components/useSessionAgentStatus.ts` → `src/hooks/useSessionAgentStatus.ts`
- `src/components/useDebouncedAgentStatus.ts` → `src/hooks/useDebouncedAgentStatus.ts`
- `src/components/useSessionTitle.ts` → `src/hooks/useSessionTitle.ts`

## Files to touch
- `src/components/CommandPalette/` → `src/components/command-palette/`
- `src/components/useSessionAgentStatus.ts` → `src/hooks/`
- `src/components/useDebouncedAgentStatus.ts` → `src/hooks/`
- `src/components/useSessionTitle.ts` → `src/hooks/`
- All files importing from these paths — update import paths

## Steps
1. Rename the CommandPalette directory
2. Move the three hooks to src/hooks/
3. Update ALL import paths across the codebase
4. Run `bun run typecheck` to verify
