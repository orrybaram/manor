---
title: Enter renames, sidebar holds focus, right-click keeps the input
status: in-progress
priority: high
assignee: opus
blocked_by: [4]
---

# Enter renames, sidebar holds focus, right-click keeps the input

Three rename fixes that all land on the same two components.

## 1. Rows can hold focus

Every workspace row and every folder header gets `tabIndex={0}` and
`data-sidebar-row` (the attribute is the contract the terminal guard below
reads — put it on the same element that takes focus). Add a `:focus-visible`
ring in `ProjectItem.module.css`, using the existing accent token; it must be
visible against both the active-row and drop-target backgrounds.

Do not add `role="treeitem"`/`aria-*` beyond what is already there; this
ticket is about the focus mechanics, not a full a11y tree.

## 2. Keys on a focused row

On the row's `onKeyDown`, and only while that row is not editing:

- **Enter** — start the inline rename (the workspace's `startRename(ws)`, or
  the folder's `startRename()`). `preventDefault()`.
- **↑ / ↓** — move focus to the previous/next `[data-sidebar-row]` in document
  order. Query from the sidebar root, not from the project, so focus crosses
  folders and projects. `preventDefault()` so the list does not scroll twice.
- **← / →** on a folder header — collapse / expand it.
- **Escape** — hand focus back to the pane: blur the row and call the new
  `refocusActivePane()` store action (below).

Keys must not fire while the inline `<input>` is open — the input's own
`onKeyDown` already handles Enter/Escape, so stop propagation there rather
than duplicating the guard in two places.

**Remove the `onDoubleClick` rename** from the workspace row and the folder
header, and drop the now-unused `onDoubleClick` prop from `WorkspaceItem`.
Rename stays reachable by Enter, the context menu and the app menu.

## 3. The terminal stops stealing sidebar focus

`src/hooks/useTerminalLifecycle.ts` focuses the pane's xterm whenever it
becomes the focused pane of the active tab, which today yanks focus back the
instant a sidebar click switches workspaces.

- In that effect, skip `term.focus()` when
  `document.activeElement?.closest("[data-sidebar-row]")` is non-null.
- Add `paneFocusNonce: number` and `refocusActivePane()` to
  `src/store/app-store.ts`; the action bumps the nonce. Add the nonce to the
  effect's dependency array and focus unconditionally (ignoring the sidebar
  guard) when the nonce is what changed — that is the explicit "put me back in
  the terminal" path Escape uses.
- Keep the existing `t.refresh(0, t.rows - 1)` call alongside the focus.

Cover the nonce in `src/store/__tests__/app-store.test.ts`.

## 4. Right-click must not close a rename

Both the workspace row's and the folder header's `ContextMenu.Trigger` take
`disabled={isEditing}`. With the trigger disabled, right-clicking the inline
input falls through to the OS text-field menu and the edit survives instead of
being committed by the blur the menu used to cause.

## Manual check (state it in your commit body)

Click a workspace row — the ring appears and the terminal does *not* take
focus; press Enter, rename, press Enter again to commit. Arrow up and down
across folders and projects. Press Escape on a row and confirm typing reaches
the terminal again. Open a rename and right-click inside the input: the input
stays open.

## Files to touch
- `src/components/sidebar/ProjectItem.tsx` — tabIndex, key handling, drop double-click, disabled trigger
- `src/components/sidebar/FolderItem.tsx` — same for the folder header
- `src/components/sidebar/ProjectItem.module.css` — focus ring
- `src/hooks/useTerminalLifecycle.ts` — sidebar focus guard, nonce dependency
- `src/store/app-store.ts` — `paneFocusNonce`, `refocusActivePane()`
- `src/store/__tests__/app-store.test.ts` — nonce coverage

## Verify
`pnpm test:unit`, `pnpm lint` and `pnpm build` pass.
