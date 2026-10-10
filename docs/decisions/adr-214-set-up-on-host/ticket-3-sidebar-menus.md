---
title: Sidebar — Set up on ▸ and Remove from <host>
status: in-progress
priority: high
assignee: sonnet
blocked_by: [2]
---

# Sidebar: Set up on ▸ and Remove from <host>

Implement ADR-214's "Surfaces → Sidebar" section and the remove-from-host confirm.

## Steps
1. Rename `src/components/sidebar/ProjectTransferMenu.tsx` to `ProjectSetUpMenu.tsx`.
   - It is copy mode only, labelled "Set up on". Targets come from `transferTargets(…, "copy")`, and "Choose location…" comes last.
   - Selecting a target calls `setUpOnHost`.
   - Delete `useMoveConfirm.tsx`.
2. `ProjectItem.tsx`:
   - **Lone project (`!isSection`):** the menu has "Set up on ▸", plus the existing items, plus "Remove Project". Remove "Copy to", "Move to", "Link with…" (with its "Choose local folder…") and "Unlink".
   - **Section (`isSection`):** add "Remove from <host label>", which calls `openRemoveFromHost({ projectId })`. Remove "Move to".
   - The command palette's `remove-project` on a section should open the same remove-from-host confirm.
3. `ProjectGroupItem.tsx`: the header menu has "Set up on ▸" and "Remove Project". Remove "Copy to" and "Link with…".
4. New `src/components/sidebar/RemoveFromHostDialog.tsx`, or a `variant` prop on `RemoveProjectDialog` if that's cleaner.
   - Use `ConfirmDialog` with the text: "Remove <name> from <host>? Files there aren't deleted. Its N workspaces on <host> won't show in Manor." Leave the workspaces sentence out when N is 0.
   - On confirm, call `removeFromHost`.
   - Mount it once, driven by the `removeFromHost` store state (the store's success-toast action opens it too), next to `TransferDialogHost` in `App.tsx`.
5. Clean up `sidebar-items.ts` helpers (`linkChoices`, `canLinkLocalFolder`) that are now unused, together with their tests, if knip flags them.

## Files to touch
- `src/components/sidebar/ProjectSetUpMenu.tsx` (renamed)
- `src/components/sidebar/useMoveConfirm.tsx` (deleted)
- `src/components/sidebar/ProjectItem.tsx`
- `src/components/sidebar/ProjectGroupItem.tsx`
- `src/components/sidebar/RemoveFromHostDialog.tsx` (new)
- `src/App.tsx`
- `src/utils/sidebar-items.ts` and `sidebar-items.test.ts`
