---
title: Wire DiffPane into LeafPane, SessionButton, title, and sidebar click
status: done
priority: high
assignee: sonnet
blocked_by: [1, 2]
---

# Wire DiffPane into LeafPane, SessionButton, title, and sidebar click

Connect the DiffPane component to the existing pane routing, tab UI, and sidebar entry point.

## Files to touch

- `src/components/LeafPane.tsx` — Add a third content type branch. When `contentType === "diff"`, render `<DiffPane paneId={paneId} />`. Import `DiffPane` from `./DiffPane`. The status bar for diff panes should show the title "Diff" (use `paneStatusTitle` span, same as terminal). No nav controls needed (read-only).

- `src/components/SessionButton.tsx` — Add diff icon. Import `GitCompareArrows` from `lucide-react`. When `contentType === "diff"`, show the icon before the title (same pattern as `Globe` for browser tabs): `{isDiff && <GitCompareArrows size={12} className={styles.sessionIcon} />}`

- `src/components/useSessionTitle.ts` — Add a case for diff panes. Read `paneContentType` and if it's `"diff"`, return `"Diff"`.

- `src/components/ProjectItem.tsx` — Make the diff stats clickable. Wrap the existing `<span className={styles.diffStats}>` in a clickable handler. On click:
  1. Stop propagation (so workspace selection doesn't trigger)
  2. Call `useAppStore.getState().addDiffSession(ws.path)`
  3. Also needs to select the workspace first if not already selected, so call `onSelectWorkspace(idx)` before opening the diff tab
  4. Add `cursor: pointer` styling to the diffStats span (in `Sidebar.module.css`)
