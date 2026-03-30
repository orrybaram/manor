---
title: Add backend methods for issue assignment and status transitions
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add backend methods for issue assignment and status transitions

Add methods to GitHubManager and LinearManager for marking issues as in-progress, plus IPC wiring and type declarations.

## GitHub

In `electron/github.ts`, add:

```typescript
async assignIssue(repoPath: string, issueNumber: number): Promise<void> {
  await execFileAsync("gh", ["issue", "edit", String(issueNumber), "--add-assignee", "@me"], {
    cwd: repoPath, encoding: "utf-8", timeout: 10000,
  });
}
```

## Linear

In `electron/linear.ts`, add:

```typescript
async startIssue(issueId: string): Promise<void> {
  // 1. Get the issue's team workflow states
  // 2. Find the first state with type "started"
  // 3. Mutation: update issue state to that stateId
  // 4. Also assign to viewer if unassigned
}
```

This requires two GraphQL calls:
1. Query to get the issue's team ID, current assignee, and the team's workflow states
2. Mutation `issueUpdate(id: $issueId, input: { stateId: $stateId, assigneeId: $viewerId })` — only include assigneeId if currently unassigned

Wrap both methods in try/catch — these are fire-and-forget; failures should not block workspace creation.

## IPC + Types

- `electron/main.ts`: Add handlers `"github:assignIssue"` and `"linear:startIssue"`
- `electron/preload.ts`: Expose via `contextBridge`
- `src/electron.d.ts`: Add type declarations

## Files to touch
- `electron/github.ts` — Add `assignIssue` method
- `electron/linear.ts` — Add `startIssue` method
- `electron/main.ts` — Add IPC handlers
- `electron/preload.ts` — Expose new IPC calls
- `src/electron.d.ts` — Type declarations
