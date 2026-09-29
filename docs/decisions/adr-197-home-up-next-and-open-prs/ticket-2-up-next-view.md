---
title: Dedicated Up next palette view and shared start-work hook
status: todo
priority: high
assignee: opus
blocked_by: [1]
---

# Dedicated Up next palette view and shared start-work hook

## Shared hook

- Move the issue-start logic out of `HomeDashboard.tsx` into `src/components/sidebar/HomeDashboard/useStartUpNextIssue.ts`. The logic to move is `handleUpNextClick`: the `startingRef` guard, the `queryClient.fetchQuery` calls for the GitHub and Linear issue detail, and `startGitHubIssueWork` / `startLinearIssueWork`.
- It exports `useStartUpNextIssue(onNewWorkspace?: NewWorkspaceHandler): (row: UpNextRow) => Promise<void>`.
- `HomeDashboard` then uses it. Its behaviour stays the same.

## Palette view

- Add `"up-next"` to `PaletteView` in `src/components/command-palette/types.ts`.
- Add `src/components/command-palette/UpNextView.tsx`. Model it on `GitHubIssuesView.tsx` / `LinearIssuesView.tsx`: same cmdk item classes, the `IssueListSkeleton` while `loading`, and the same empty state.
  - Read `useUpNextIssues().all` and render one `Command.Group` per project, with `heading` set to `row.entryName`, in the order given.
  - Each `Command.Item` has:
    - a `value` or `keywords` that includes the identifier, the title and the project name, so the palette search matches them;
    - the source icon (`GitHubIcon` / `LinearIcon`);
    - the identifier, dimmed, then the title;
    - a small "ready" hint when `row.issue.labels` includes `ready-for-agent`.
  - `onSelect` calls `useStartUpNextIssue(onNewWorkspace)` for the row, then the palette's `onClose`.
  - Reuse the existing CSS module classes from `CommandPalette.module.css` where you can.
- In `src/components/command-palette/CommandPalette.tsx`:
  - Add `up-next` to `isIssueListView`.
  - Set the header text to "Up next".
  - Render `<UpNextView ... />` when `view === "up-next"`.
  - Also report the empty state through `issueListEmpty` / `onEmptyChange`, the way the other views do.
  - **Note:** this file contains a literal NUL byte at `FREQUENT_KEYWORD` (line ~45). Edit it only with the Edit tool (or a careful `sed`), never rewrite the whole file, and keep that byte. `grep` needs `-a` to search it.

## Dashboard link

In `src/components/sidebar/HomeDashboard/HomeDashboard.tsx`:
- Remove `allIssuesView` and the `selectedProject` / `selectedProjectIndex` code it relies on, if nothing else uses it.
- Change the header link to `View all (N)`, where N is `upNext.total`, calling `onOpenPaletteView("up-next")`.
- Show the link only when `upNext.total > upNext.top.length`, or always. Always is fine: it's the dedicated view.

## Verification

- `pnpm exec tsc --noEmit` passes (or the project's typecheck; check `tsconfig*.json` for the renderer project).
- `pnpm lint` shows no new errors in the touched files.
- `pnpm knip:ci` passes (the new exports must be used).

## Files to touch
- `src/components/sidebar/HomeDashboard/useStartUpNextIssue.ts` (new)
- `src/components/sidebar/HomeDashboard/HomeDashboard.tsx`
- `src/components/command-palette/types.ts`
- `src/components/command-palette/UpNextView.tsx` (new)
- `src/components/command-palette/CommandPalette.tsx`
