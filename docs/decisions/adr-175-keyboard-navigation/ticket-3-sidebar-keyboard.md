---
title: Sidebar rows — all focusable, Enter opens, F2 renames, roving tabindex, focus ring
status: done
priority: critical
assignee: opus
blocked_by: [2]
---

# Sidebar rows — all focusable, Enter opens, F2 renames, roving tabindex, focus ring

1. `src/lib/sidebar-row.ts`:
   - Actions become `{ activate, startRename?, setExpanded?, openMenu? }`.
   - Enter / Space → `activate()`. F2 → `startRename()`. Home/End → first/last
     row. ← / → → `setExpanded` (project headers and folders).
     Shift+F10, ContextMenu key, Meta+. → `openMenu` (wired in ticket 5; leave
     the hook point now, default no-op).
   - Roving tabindex helper: `useRovingRow(isCurrent)` or a function that sets
     `tabIndex` 0 on exactly one row (the active workspace row, else the
     first row) and -1 on the rest; moving focus with arrows updates which
     row holds 0.
2. Home row (`Sidebar.tsx:286`): make it a focusable row (`data-sidebar-row`,
   role none needed), Enter → go home (same handler as click).
3. Project header (`ProjectItem.tsx:765`): focusable row,
   `data-testid="project-header"`, Enter/Space toggles collapse, ←/→
   collapse/expand, `aria-expanded`.
4. Workspace row: Enter/Space → the same select handler as click;
   `aria-current="true"` on the active one. F2 → rename.
   Folder header (`FolderItem.tsx`): Enter/Space toggles, F2 renames.
5. Rename inputs (`ProjectItem.tsx:489`, `FolderItem.tsx:194`): only
   `stopPropagation` when neither metaKey nor ctrlKey is held, so app
   shortcuts still dispatch.
6. Focus ring: restore a `:focus-visible` outline on rows
   (`ProjectItem.module.css:123-130`, folder/home equivalents) using the
   theme accent token. `:focus` without `-visible` stays ringless (ADR-172
   follow-up: no ring on click).
7. Update `tests/e2e/workspace-rename.spec.ts` and any other spec / docs that
   rely on Enter-to-rename to use F2. Update ADR-172 mention in docs if the
   keyboard shortcut list lives in README.
8. Update/extend unit tests for `sidebar-row.ts` if they exist.

## Files to touch
- `src/lib/sidebar-row.ts`
- `src/components/sidebar/Sidebar.tsx`, `ProjectItem.tsx`, `FolderItem.tsx`, their `.module.css`
- `tests/e2e/workspace-rename.spec.ts`, docs
