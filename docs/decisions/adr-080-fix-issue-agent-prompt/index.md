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

# ADR-080: Fix issue info missing from agent prompt on workspace creation

## Context

When creating a new workspace from a Linear or GitHub ticket (via Shift+Enter in the issue detail view), the issue title and description should be passed as the initial prompt to the agent. Users report the issue information is not making it into the agent command.

The current flow stores `agentPrompt` in React state (`useState`) in App.tsx. The `onSubmit` callback for `NewWorkspaceDialog` captures `agentPrompt` from its render-time closure. This is fragile because the closure value depends on which render cycle created it.

Additionally, the recent eslint fix (commit `3ccc682`) moved `issueDetailRef` assignments from direct render-time updates to `useEffect` in `IssueDetailView.tsx`, introducing a one-frame delay where the ref could be stale.

## Decision

Use `useRef` to mirror `agentPrompt` and `pendingLinkedIssue` alongside state, ensuring callbacks always read the latest values regardless of render timing:

1. **App.tsx**: Add refs for `agentPrompt` and `pendingLinkedIssue`. Update refs synchronously in `handleNewWorkspace` and `closeNewWorkspace`. Read from refs in the `onSubmit` callback.

2. **IssueDetailView.tsx**: The `handleCreateWorkspace` callback reads `issueDetailRef.current?.description` for the prompt. Since the ref is now updated in a `useEffect` (post-eslint-fix), we should also pass the description through the `issue` parameter by widening the parameter type to accept `LinearIssueDetail`, eliminating the ref dependency for prompt construction.

## Consequences

- Agent prompt is reliably passed when creating workspaces from tickets
- Refs ensure callbacks always read the latest value regardless of React render cycle timing
- No API changes to `NewWorkspaceDialog`
- Minimal code change, focused on the state management layer

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
