---
title: Open PRs widget on Home
status: done
priority: medium
assignee: sonnet
blocked_by: [1, 2]
---

# Open PRs widget on Home

Add an "Open PRs" section to `HomeDashboard.tsx`, below Up next and above the summary line. It reads `openPrRows(projects)` from ticket 1, memoised on `projects`.

## Section

- Use the same structure as the other sections: `shared.section` and a `shared.sectionHeader` reading "Open PRs" followed by the count, using `CountBadge` if the other headers do (check how Needs you renders its header).
- Show up to `PR_VISIBLE_COUNT = 5` rows. Add an "N more" / collapse toggle that mirrors Needs you's `expanded` / `moreCount` pattern, with its own state.
- Hide the section when there are no rows.

## Row

Each row is a `<Button variant="ghost" className={`${shared.action} ${styles.row}`}>` containing:
- **Leading:** `<PrPopover pr={row.pr} workspacePath={row.workspace.path} hostId={row.project.hostId} onOpen={() => window.electronAPI.shell.openExternal(row.pr.url)} />`, from `../PrPopover`. It already renders the readiness-coloured `#N` badge and the hover popover.
  - `PrPopover` stops pointer-down and click propagation on its trigger. Confirm that clicking the badge doesn't also trigger the row, and fix it if it does.
  - Nesting `role="button"` inside a `<button>` is invalid HTML. If `Button` renders a `<button>`, make the row a `div` with `role="button"`, `tabIndex={0}` and Enter handling, using the same classes. Otherwise nest as-is. Pick whichever matches existing patterns; `ProjectItem.tsx` renders `PrPopover` inside a workspace row, so check how it does it.
- **Label:** the PR title, ellipsised, using `styles.label`.
- **Meta** (`styles.meta`):
  - the status `label`, coloured by readiness: blocked is `var(--red)`, ready is `var(--green)`, review / queued / pending are `var(--text-dim)`;
  - the project chip (`styles.proj` with `projectColorStyle(project.color)`, as in Up next) showing the workspace name (`workspace.name ?? workspace.path`).

Clicking the row selects the workspace. Reuse the PR branch of `handleItemClick`: find the project index, find the workspace index, then `selectProject` + `selectWorkspace`. Extract a small `selectWorkspaceOf(project, workspace)` callback so Needs you and Open PRs share it.

## Styles

Add any new classes to `HomeDashboard.module.css`, such as a status-label class. Keep it small and match the existing meta styling.

## Verification

- Typecheck, lint and `pnpm knip:ci` all pass.
- The Home dashboard tests still pass (`pnpm vitest run src/lib/__tests__/home-dashboard.test.ts`).

## Files to touch
- `src/components/sidebar/HomeDashboard/HomeDashboard.tsx`
- `src/components/sidebar/HomeDashboard/HomeDashboard.module.css`
