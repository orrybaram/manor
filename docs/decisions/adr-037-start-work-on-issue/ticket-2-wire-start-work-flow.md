---
title: Wire "Start Work" flow through issue detail views and workspace creation
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Wire "Start Work" flow through issue detail views and workspace creation

Connect the backend methods from ticket 1 to the existing issue detail → create workspace flow.

## 1. Extend onNewWorkspace opts

In `src/components/CommandPalette/types.ts`, add `agentPrompt?: string` to the `onNewWorkspace` options.

## 2. Update issue detail views to pass prompt and call issue actions

### IssueDetailView.tsx (Linear)

In `handleCreateWorkspace`:
- After calling `onNewWorkspace`, also call `window.electronAPI.linear.startIssue(issue.id)` (fire-and-forget, no await needed in the UI)
- Pass `agentPrompt: issue.title + "\n\n" + (issue.description ?? "")` in the `onNewWorkspace` opts
- The `name` should be `issue.title` (already correct)

### GitHubIssueDetailView.tsx (GitHub)

In `handleCreateWorkspace`:
- After calling `onNewWorkspace`, also call `window.electronAPI.github.assignIssue(repoPath, issueDetail.number)` (fire-and-forget)
- Pass `agentPrompt: issueDetail.title + "\n\n" + (issueDetail.body ?? "")` in the `onNewWorkspace` opts
- The `name` should be `issueDetail.title` (already correct — this is the workspace display name, NOT the branch)

## 3. Thread agentPrompt through App.tsx

In `handleNewWorkspace`, store `agentPrompt` in state alongside `initialName` and `initialBranch`.

In `NewWorkspaceDialog`'s `onSubmit` handler (in App.tsx), when `agentPrompt` is present:
- After `createWorktree` succeeds, build the startup command: `{project.agentCommand} "{escapedPrompt}"`
- Call `setPendingStartupCommand(wsPath, command)` — this overrides any `worktreeStartScript` that was set during `createWorktree`
- Shell-escape the prompt (replace `"` with `\"`, `$` with `\$`, backticks with `\``)

Note: The `createWorktree` in project-store already sets `worktreeStartScript` as pending startup command. When `agentPrompt` is provided, we call `setPendingStartupCommand` again AFTER createWorktree returns, overriding it.

## 4. Update footer hint text

Change the footer hint from "Create Workspace" to "Start Work" in both detail views to reflect the enhanced behavior.

## Files to touch
- `src/components/CommandPalette/types.ts` — Add `agentPrompt` to opts
- `src/components/CommandPalette/IssueDetailView.tsx` — Pass prompt, call startIssue
- `src/components/CommandPalette/GitHubIssueDetailView.tsx` — Pass prompt, call assignIssue
- `src/App.tsx` — Thread agentPrompt, build agent startup command after workspace creation
