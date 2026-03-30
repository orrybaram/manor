---
title: Extend Linear API with issue detail endpoint
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Extend Linear API with issue detail endpoint

Add a `getIssueDetail` method to `LinearManager` and wire it through IPC.

## Changes

### 1. Update `LinearIssue` type and add `LinearIssueDetail`

In `electron/linear.ts`, add a new `LinearIssueDetail` interface that extends `LinearIssue` with:
- `description: string | null` — issue description (markdown)
- `labels: Array<{ id: string; name: string; color: string }>` — issue labels
- `assignee: { id: string; name: string; displayName: string; avatarUrl: string | null } | null`

Also add `labels` (just `Array<{ name: string; color: string }>`) to the existing list query — these are lightweight and useful in the list view too.

### 2. Add `getIssueDetail` method to `LinearManager`

```typescript
async getIssueDetail(issueId: string): Promise<LinearIssueDetail>
```

GraphQL query should fetch: `id`, `identifier`, `title`, `url`, `branchName`, `priority`, `description`, `state { name type }`, `labels { nodes { id name color } }`, `assignee { id name displayName avatarUrl }`.

### 3. Wire IPC handler

In `electron/main.ts`, add:
```typescript
ipcMain.handle("linear:getIssueDetail", async (_event, issueId: string) => {
  return linearManager.getIssueDetail(issueId);
});
```

In `electron/preload.ts`, expose `linearGetIssueDetail`.

### 4. Update types

In `src/electron.d.ts`:
- Add `LinearIssueDetail` interface
- Add `linearGetIssueDetail: (issueId: string) => Promise<LinearIssueDetail>` to `ElectronAPI`
- Add `labels` to existing `LinearIssue` type

## Files to touch
- `electron/linear.ts` — add `LinearIssueDetail` type and `getIssueDetail` method, add labels to list query
- `electron/main.ts` — add IPC handler for `linear:getIssueDetail`
- `electron/preload.ts` — expose `linearGetIssueDetail` in context bridge
- `src/electron.d.ts` — add `LinearIssueDetail` type and API method, update `LinearIssue`
