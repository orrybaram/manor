---
title: Host status for linked groups
status: done
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

## Notes

- Keeping an offline section's last known workspaces needed a change in main:
  `buildProjectInfo` fell back to the main checkout alone whenever git could
  not list worktrees, which is always the case while a remote host is away.
  `ProjectManager` now remembers each remote project's last successful listing
  (`LastKnownWorkspaces` in `electron/projects/project-info.ts`, keyed by the
  project's host and path) and serves it only while the registry reports that
  host as not connected. A connected host that lists nothing gets the main
  checkout, never stale worktrees. Entries are dropped when a project is
  removed or moved. The cache is in memory only, so a host that is away from
  launch on still shows just its main checkout. Local projects are unchanged.
- "Partially offline" and "Offline" each have their own icon and word on the
  group header (`CloudAlert` + "Partial", `CloudOff` + "Offline"); only a
  fully offline group dims its name. A host still connecting or reconnecting
  counts as away, as for pane input (`isHostOffline`).
- The offline section is dimmed by a wrapper in `ProjectGroupItem`, so
  `ProjectItem` is not touched.
