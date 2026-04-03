---
title: Create DiffPane component with diff2html rendering
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Create DiffPane component with diff2html rendering

Build the DiffPane React component that fetches and renders the unified diff using diff2html.

## Prerequisites

Install `diff2html`: `npm install diff2html`

## Files to touch

- `src/components/DiffPane.tsx` — New file. Component that:
  1. Accepts `paneId: string` prop
  2. Reads `paneDiffPath[paneId]` from `useAppStore` to get the workspace path
  3. Looks up the workspace's `defaultBranch` from `useProjectStore` (find the project containing the workspace path, use `project.defaultBranch`)
  4. On mount (and when workspace path changes), calls `window.electronAPI.diffs.getFullDiff(workspacePath, defaultBranch)`
  5. Passes the raw unified diff string to `diff2html`'s `html` function with `{ drawFileList: false, matching: 'lines', outputFormat: 'line-by-line' }`
  6. Renders the HTML via `dangerouslySetInnerHTML` in a scrollable container
  7. Imports `diff2html/bundles/css/diff2html.min.css` for styling
  8. Shows a loading state while fetching
  9. Shows an "No changes" empty state if diff is empty string
  10. Has a title bar showing "Diff: {branchName} vs {defaultBranch}" at the top

- `src/components/DiffPane.module.css` — New file. Styles:
  1. `.container` — full height, overflow-y auto, background matching app theme
  2. `.header` — sticky top bar with title text
  3. `.empty` — centered "No changes" message
  4. Override diff2html colors to work with the app's dark theme (set CSS variables on the container for `.d2h-wrapper`, `.d2h-file-header`, `.d2h-code-line-ctn`, etc.)
