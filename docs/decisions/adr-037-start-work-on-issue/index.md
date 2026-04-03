---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-037: Start Work on Issue

## Context

When a user selects a GitHub or Linear issue from the command palette, the current flow creates a workspace (git worktree) and navigates to it. But the user then has to manually:

1. Open a new session and type the agent command with the issue context
2. Go to GitHub/Linear and mark the issue as in-progress or assign themselves

This is friction that should be automated. The workspace creation from an issue is a "start work" action — it should set up the full working context automatically.

## Decision

Extend the issue detail views' "Create Workspace" action to also:

1. **Run the agent command with issue context** — After workspace creation, set a pending startup command that runs the project's `agentCommand` with the issue title and description as a prompt. The command will be: `{agentCommand} "{title}\n\n{description}"`. This reuses the existing `pendingStartupCommand` mechanism that already runs `worktreeStartScript`.

2. **Mark issue in-progress** — Fire-and-forget calls to update issue status:
   - **GitHub**: `gh issue edit {number} --add-assignee @me` (assign current user; proceed silently if already assigned)
   - **Linear**: GraphQL mutation to transition issue to "In Progress" state (find the first workflow state with type `started`) and assign to viewer if unassigned

The startup command takes priority over `worktreeStartScript` when creating from an issue — the agent command with issue context IS the startup action. If both exist, the agent command with issue context wins.

### Workspace naming

- **GitHub**: Use the issue title directly (titlecased), without the issue number. Branch name remains `{number}-{slug}` as today.
- **Linear**: Use the issue title directly. Branch name remains the Linear-provided `branchName`.

### Key files

- `src/components/CommandPalette/IssueDetailView.tsx` — Linear detail: pass issue title+description when creating workspace
- `src/components/CommandPalette/GitHubIssueDetailView.tsx` — GitHub detail: pass issue title+description when creating workspace
- `src/components/CommandPalette/types.ts` — Extend `onNewWorkspace` opts to include `agentPrompt`
- `src/App.tsx` — Thread `agentPrompt` through to workspace creation, use it as startup command
- `src/store/project-store.ts` — When `agentPrompt` is provided, build agent startup command and set as pending startup command (overriding `worktreeStartScript`)
- `electron/github.ts` — Add `assignIssue(repoPath, issueNumber)` method
- `electron/linear.ts` — Add `startIssue(issueId)` method (transition to started + assign)
- `electron/main.ts` — Add IPC handlers for the new methods
- `electron/preload.ts` — Expose the new IPC calls
- `src/electron.d.ts` — Type declarations for new IPC methods

## Consequences

- **Better**: One-action "start work" flow — pick issue, press Enter, workspace is ready with agent running and issue marked in-progress.
- **Better**: No new UI needed — the existing Enter key / "Create Workspace" action gains the new behavior automatically.
- **Tradeoff**: The agent prompt is passed as a quoted string argument. Very long descriptions could hit shell argument limits, but in practice issue descriptions are well within limits.
- **Risk**: Linear state transition assumes a "started" type workflow state exists. This is standard in Linear but could fail for custom workflows — we handle this gracefully by skipping the transition.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
