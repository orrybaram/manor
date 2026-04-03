---
title: Add agent status indicator to workspace items
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add agent status indicator to workspace items

Create `useWorkspaceAgentStatus` hook and replace static icons in `ProjectItem.tsx`.

## Implementation

### 1. Create `src/hooks/useWorkspaceAgentStatus.ts`

A hook that takes a workspace path and returns the highest-priority non-idle `AgentStatus` for that workspace, or `null`. Pattern after `useProjectAgentStatus` but for a single workspace.

### 2. Update `src/components/ProjectItem.tsx`

Replace the static icon block (lines 205-211) with an `AgentDot` when there's active status, falling back to `House`/`FolderGit2` when idle. Import and call `useWorkspaceAgentStatus` for each workspace.

Since hooks can't be called inside `.map()`, extract the workspace rendering into a `WorkspaceItem` sub-component that can use the hook.

## Files to touch
- `src/hooks/useWorkspaceAgentStatus.ts` — new file, create the hook
- `src/components/ProjectItem.tsx` — extract WorkspaceItem component, replace icon with AgentDot
