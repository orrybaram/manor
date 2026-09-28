---
title: Sidebar multi-select works across a group's host sections
status: todo
priority: low
assignee: opus
blocked_by: [1]
---

# Sidebar multi-select works across a group's host sections

GitHub issue #250. See ADR-192 §5. This ticket is also blocked on the
ADR-190 sidebar multi-select work being merged.

- The ADR-190 group-tree helpers treat host sections as part of the group's tree.
- Range and toggle selection work across sections.
- Bulk actions run each workspace's action against its own member project and host.
- Cover selection across sections in the sidebar-items tests.

## Files to touch
- `src/utils/sidebar-items.ts`, `src/utils/sidebar-items.test.ts`
- The ADR-190 selection store and hooks
- `src/components/sidebar/ProjectGroupItem.tsx`
