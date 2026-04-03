---
title: Add getAllIssues method to LinearManager
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Add getAllIssues method to LinearManager

Add a method to `LinearManager` that fetches all team issues (not just the viewer's assigned ones).

## Method to Add

### `getAllIssues(teamIds: string[], options?: GetMyIssuesOptions): Promise<LinearIssue[]>`

GraphQL query — query `issues` on teams instead of `viewer.assignedIssues`:

```graphql
query($teamIds: [ID!]!, $stateTypes: [String!]!, $first: Int!) {
  issues(
    filter: {
      team: { id: { in: $teamIds } }
      state: { type: { in: $stateTypes } }
    }
    first: $first
    orderBy: priority
  ) {
    nodes {
      id identifier title url branchName priority
      state { name type }
      labels { nodes { name color } }
    }
  }
}
```

- Default `stateTypes`: `["unstarted"]`
- Default `limit`: 50
- Sort result by priority ascending (urgent=1 first, no priority=0 last — same pattern as `getMyIssues`)
- Transform labels from `{ nodes: [...] }` to flat array, same as `getMyIssues`

## Files to touch
- `electron/linear.ts` — add `getAllIssues` method to `LinearManager` class
