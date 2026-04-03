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

# ADR-009: GitHub integration section + unresolved comments in PR popover

## Context

The PR popover (ADR-007) shows PR state, CI checks, review decision, and diff stats but not unresolved review thread counts. Additionally, GitHub integration relies on the `gh` CLI being installed and authenticated, but there's no UI to tell users about this requirement — it just silently fails. The Integrations page only has a Linear section.

## Decision

Two changes:

### 1. GitHub section in Integrations page

Add a `GitHubIntegrationSection` component to `IntegrationsPage.tsx`, following the same pattern as `LinearIntegrationSection`. It will:

- On mount, call a new IPC method `github:checkStatus` that runs `gh auth status` to detect if `gh` CLI is installed and authenticated
- Show connected state with the authenticated GitHub username
- Show disconnected state with instructions to install `gh` CLI and run `gh auth login`, with a link to the GitHub CLI install page
- Reuse existing CSS classes from the Linear section (`linearConnected` → rename to generic `integrationConnected`, etc.) or use the same class names directly since the styling is identical

Backend: Add `checkStatus()` method to `GitHubManager` that runs `gh auth status --hostname github.com` and parses the output for the username. Wire through IPC + preload + type defs.

### 2. Unresolved review threads in PR popover

Add `unresolvedThreads` count to `PrInfo` data model. In `GitHubManager`, after the existing `gh pr list` call, make a follow-up `gh api graphql` call to fetch review thread resolution status. Parse owner/repo from the PR URL. Display count in popover with `MessageSquare` icon when > 0.

## Consequences

- Users get clear guidance on setting up GitHub CLI — no more silent failures
- One extra `gh api graphql` call per PR per poll cycle (60s), acceptable overhead
- If GraphQL call fails, field is gracefully omitted
- CSS class naming could be generalized but keeping `linear*` prefix avoids churn — the GitHub section can reuse the same classes

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
