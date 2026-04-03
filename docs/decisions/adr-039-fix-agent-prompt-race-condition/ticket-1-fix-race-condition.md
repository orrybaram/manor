---
title: Fix agent prompt race condition in createWorktree
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Fix agent prompt race condition in createWorktree

## Problem

The agent command from issue detail is set via `setPendingStartupCommand` AFTER `createWorktree` resolves, but the terminal has already consumed (and found nothing) by that point because `setActiveWorkspace` inside `createWorktree` triggers the terminal mount.

## Implementation

### 1. `src/store/project-store.ts` — Add `agentCommand` param to `createWorktree`

Change signature from:
```ts
createWorktree: async (projectId: string, name: string, branch?: string)
```
to:
```ts
createWorktree: async (projectId: string, name: string, branch?: string, agentCommand?: string)
```

In the command-setting block (lines 248-257), combine `worktreeStartScript` and `agentCommand`:
- If both exist: join with ` && `
- If only one exists: use that one
- Set the combined command via `setPendingStartupCommand` before `setActiveWorkspace`

### 2. `src/App.tsx` — Move command construction before createWorktree call

In the `onSubmit` handler (lines 289-307):
- Build the escaped agent command string BEFORE calling `createWorktree`
- Pass it as the 4th argument to `createWorktree`
- Remove the post-call `setPendingStartupCommand` block

## Files to touch
- `src/store/project-store.ts` — add agentCommand param, combine commands before setActiveWorkspace
- `src/App.tsx` — move command construction, pass to createWorktree, remove post-call block
