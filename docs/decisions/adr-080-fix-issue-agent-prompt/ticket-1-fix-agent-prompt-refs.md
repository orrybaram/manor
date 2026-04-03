---
title: Fix agent prompt state with refs in App.tsx and IssueDetailView
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Fix agent prompt state with refs

Use refs to ensure `agentPrompt` and `pendingLinkedIssue` are reliably available in the `NewWorkspaceDialog` submit callback.

## Files to touch

- `src/App.tsx` — Add `agentPromptRef` and `pendingLinkedIssueRef`. Update synchronously in `handleNewWorkspace` and `closeNewWorkspace`. Read from refs in `onSubmit`.

- `src/components/CommandPalette/IssueDetailView.tsx` — Change `handleCreateWorkspace` to accept `LinearIssueDetail` instead of `LinearIssue` and use `issue.description` directly instead of reading from `issueDetailRef.current?.description`.
