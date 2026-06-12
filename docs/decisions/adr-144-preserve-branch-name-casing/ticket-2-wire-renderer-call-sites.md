---
title: Wire renderer call sites to the branch-name util
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Wire renderer call sites to the branch-name util

Replace the three duplicate `slugify()` definitions and the case-sensitive branch
comparisons in the renderer with the util from ticket-1. Import from
`src/utils/branch-name.ts`.

Rule of thumb: **branch derivation → `sanitizeBranchName` (preserves case); directory
derivation → `toDirSlug` (lowercase); branch lookups → `branchesEqual`.**

## Files to touch

- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx`
  - Delete the local `slugify` (lines 16–23).
  - The branch-preview auto-fill (line 313) and on-submit fallback (line 211) and the
    open-handler default (line 144) derive a **branch** → use `sanitizeBranchName`.
  - The placeholder/preview UX stays the same; just no forced lowercase. Typing
    `PROJ-123 My Feature` in Name should preview `PROJ-123-My-Feature`.

- `src/components/command-palette/GitHubIssueDetailView.tsx`
  - Delete the local `slugify` (lines 25–31). Build the branch as
    `${issueDetail.number}-${sanitizeBranchName(issueDetail.title)}` (line 55).
  - The existing-workspace lookup (line 61) → `branchesEqual(ws.branch, branchName)`.

- `src/components/command-palette/IssueDetailView.tsx`
  - Existing-workspace lookup (line 53) → `branchesEqual(ws.branch, issue.branchName)`.

- `src/components/sidebar/ProjectSetupWizard/ProjectSetupWizard.tsx`
  - Delete the local `slugify` (lines 15–22). Its two uses (lines 89, 166) derive a
    **project directory** name → use `toDirSlug` (behavior unchanged, just centralized).

- `src/hooks/usePrWatcher.ts`
  - Branch lookup (line 34) → `branchesEqual(w.branch, branch)`.

- `src/store/project-store.ts`
  - Post-create lookup (line 442): change the branch half to `branchesEqual(ws.branch, branchName)`
    (keep the `ws.name === name` half as-is).
  - Convert lookup (line 546): `branchesEqual(ws.branch, branch)`.
  - Update-branch early-exit (line 688): `branchesEqual(ws.branch, branch)`.

Verify no other local `slugify` definitions remain in `src/` after this
(`grep -rn "function slugify" src`).
