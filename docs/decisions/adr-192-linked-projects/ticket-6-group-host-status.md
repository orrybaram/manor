---
title: Host status for linked groups
status: todo
priority: medium
assignee: opus
blocked_by: [1]
---

# Host status for linked groups

GitHub issue #249. See ADR-192 §5. This ticket is also blocked by GitHub
issue #242 (layer 1, ADR-191).

- Derive a group's host state from its members: connected, offline, or partially offline. Make it a pure function tested in sidebar-items or host-status.
- The section of an offline host dims and keeps its last known workspaces. The other sections stay usable.
- The status bar host chip follows the active workspace's host.
- The tab badge compares the pane's host with the workspace's host.
- The agent dot on a collapsed group counts agents from every section.

## Files to touch
- `src/utils/sidebar-items.ts` or `src/lib/host-status.ts`
- `src/components/sidebar/ProjectGroupItem.tsx`, `ProjectItem.tsx`
- `src/components/statusbar/StatusBar/HostStatusIndicator.tsx`
- `src/components/tabbar/TabBar/TabBar.tsx`
- `src/hooks/useProjectAgentStatus.ts`
