---
title: Add Push button to DiffPane top bar
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Add Push button to DiffPane top bar

Add a Push button to the DiffPane top bar that calls `window.electronAPI.git.push` and shows inline loading/error state.

## Files to touch

- `src/components/workspace-panes/DiffPane/DiffPane.tsx` — changes:
  1. Add `pushing` and `pushError` state (useState).
  2. Add `handlePush` async callback: sets `pushing=true`, clears `pushError`, calls `window.electronAPI.git.push(workspacePath)`, catches errors and sets `pushError`, always sets `pushing=false`.
  3. In the top bar (around line 356), add a `<Button variant="secondary" onClick={handlePush} disabled={pushing}>` with a `GitBranch` or `CloudUpload` icon (use lucide-react — check what icons are already imported) and the label "Push". Place it to the left of the Commit button.
  4. Below the top bar div, conditionally render `pushError` as a small error message `<div>` styled similarly to how CommitModal renders its error — look at CommitModal.module.css for the `.error` class pattern and replicate inline or add to DiffPane styles.

The `workspacePath` prop is already available in DiffPane. No new props needed.

Use the existing `Button` component from `../../../ui/Button/Button` (already imported). Do NOT use raw `<button>`.

Also update `src/electron.d.ts` — add `push` to the `git` block (around line 371):
```ts
push: (wsPath: string, remote?: string, branch?: string) => Promise<void>;
```
