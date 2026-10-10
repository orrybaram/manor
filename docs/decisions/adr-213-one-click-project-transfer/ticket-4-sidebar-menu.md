---
title: Copy to / Move to submenus in the sidebar
status: done
priority: high
assignee: sonnet
blocked_by: [3]
---

# Copy to / Move to submenus in the sidebar

Implement the "Sidebar menu" part of ADR-213.

## Steps
1. New `src/components/sidebar/ProjectTransferMenu.tsx`.
   - Props: `{ project, mode, source? }`. It renders a Radix `ContextMenu.Sub` labelled "Copy to" or "Move to", in the same style as the "Link with…" submenu in `ProjectItem.tsx` (around lines 1297-1339): `SubTrigger` with a `ChevronRight`, then `Portal`, then `SubContent className={styles.contextMenu}`.
   - Items come from `transferTargets`:
     - Disabled items get the `disabled` prop and a `<Tooltip>` showing the reason.
     - After a separator, a final "Choose location…" item calls `openTransferDialog` with the default planned values. The dialog plans when its fields are empty.
   - Selecting a host:
     - **Copy:** call `transferProject` directly.
     - **Move:** first check `projectHasOpenPanes`, and whether the project has workspaces besides main. If either is true, show `ConfirmDialog`: "Moving closes this project's tabs. N workspaces stay on <old host> and won't show in Manor until you move back." On confirm, call `transferProject`.
2. `ProjectItem.tsx`:
   - When `!isSection`: add "Copy to ▸" and "Move to ▸" after "Project Settings".
   - When `isSection`: add only "Move to ▸". `transferTargets` already disables hosts the group occupies.
3. `ProjectGroupItem.tsx`: add "Copy to ▸" after "Project Settings". Its source is the local member if the group has one, otherwise the first member.
4. Use the `src/components/ui/` components (`Tooltip`, `ConfirmDialog`), per `.claude/rules/ui-components.md`. There should be no raw `<button>`.

## Files to touch
- `src/components/sidebar/ProjectTransferMenu.tsx` (new), plus a CSS module if needed
- `src/components/sidebar/ProjectItem.tsx`
- `src/components/sidebar/ProjectGroupItem.tsx`
