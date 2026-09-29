---
title: Add updatedAt/author/assignee to issue list data
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Add updatedAt/author/assignee to issue list data

ADR-197 §4. Extend list results so the Tasks table can show Updated and
Assignees for both providers.

- `electron/github.ts` (~L354–400): add `updatedAt,author` to the
  `gh issue list --json` fields for both mine/all; add `updatedAt: string` and
  `author: { login: string }` to `GitHubIssue`.
- `electron/linear.ts` (~L115–200): add `updatedAt` and
  `assignee { name displayName }` to both list GraphQL queries; add
  `updatedAt: string` and `assignee?: { name: string; displayName?: string } | null`
  to `LinearIssue`, mapping the response.
- `src/electron.d.ts` (~L813–862): mirror the type changes.
- Fix any tests/fixtures constructing these types (grep for `GitHubIssue`,
  `LinearIssue` in `*.test.ts`, `src/lib/home-dashboard*`).

## Files to touch
- `electron/github.ts`
- `electron/linear.ts`
- `src/electron.d.ts`
- tests/fixtures that build GitHubIssue/LinearIssue objects
