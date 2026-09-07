---
title: Sidebar, notifications, and ghosts respond to UI requests from the menu
status: done
priority: high
assignee: sonnet
blocked_by: [4]
---

# Sidebar, notifications, and ghosts subscribers

Ticket 4 emits `UiRequest`s from `src/utils/ui-request.ts`. Wire the owning components so the requests take effect.

## Steps

1. `src/components/sidebar/ProjectItem.tsx`: in a `useEffect`, subscribe with `onUiRequest`. For requests whose `projectId` matches this project:
   - `rename-workspace` → find the workspace by `path` and call the existing `startRename(ws)` (line ~334). If the project's workspace list is collapsed, expand it first (find the collapse state used by the row).
   - `merge-worktree` → `setConfirmMergeWorktree(ws)`; `delete-worktree` → `setConfirmDeleteWorktree(ws)`; `remove-project` → `setConfirmRemove(true)`.
   Unsubscribe on unmount. Keep the handler in a `useCallback`/ref so the effect subscribes once.
2. `src/components/notifications/NotificationsPopover.tsx`: subscribe to `open-notifications` and `setOpen(true)` (state at line ~179).
3. Ghosts: move the overlay currently rendered by `CommandPalette.tsx` (`showGhosts` state at ~82, JSX at ~568) to `App.tsx`, driven by the `showGhosts` state ticket 4 added there. The palette's "Ghosts!?" item now calls `requestUi({ type: "ghosts" })`; `App` subscribes and sets the state. Move any ghost-specific CSS from `CommandPalette.module.css` into a small `src/components/GhostsOverlay/` component if it is more than a few lines. Behaviour must be identical from the palette.
4. Add a unit test for the bus itself in `src/utils/__tests__/ui-request.test.ts` (listener receives the event, unsubscribe stops it, multiple listeners).
5. Manual smoke: Workspace › Rename Workspace starts inline rename in the sidebar; Merge/Delete/Remove open their dialogs; View › Notifications opens the popover; Help › Ghosts!? shows ghosts with the palette closed.
6. Run renderer `tsc`, `npx vitest run src`, `pnpm lint` on touched files.

## Files to touch
- `src/components/sidebar/ProjectItem.tsx` — subscribe for rename/merge/delete/remove
- `src/components/notifications/NotificationsPopover.tsx` — subscribe for open
- `src/components/command-palette/CommandPalette.tsx`, `useCommands.tsx` — ghosts via `requestUi`
- `src/App.tsx` — render ghosts overlay, subscribe
- `src/components/GhostsOverlay/` — new, if extracted
- `src/utils/__tests__/ui-request.test.ts` — new
