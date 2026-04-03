---
title: Add tests for github.ts
status: in-progress
priority: high
assignee: sonnet
blocked_by: []
---

# Add tests for github.ts

Write `electron/github.test.ts` covering all GitHubManager methods.

## Mocking strategy

Mock `node:child_process` `execFile` to control `gh` CLI output. The module uses `promisify(execFile)` so mock the callback-based `execFile` and let promisify wrap it, or mock at the module level.

Pattern:
```typescript
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));
```

Then control what `execFile` calls back with per test.

## Test cases

### `getPrForBranch(repoPath, branch)`
- Returns PR info when `gh pr list` returns valid JSON with one PR
- Returns `null` when `gh pr list` returns empty array
- Returns `null` when `gh` command fails (catch block)
- Correctly computes `checks` summary: counts SUCCESS as passing, FAILURE/CANCELLED/TIMED_OUT as failing, others as pending
- Sets `checks` to `null` when `statusCheckRollup` is empty or missing

### `getPrsForBranches(repoPath, branches)`
- Calls `getPrForBranchInner` for each branch concurrently
- Returns `[branch, null]` for branches where the lookup rejects

### `getMyIssues(repoPath)` / `getAllIssues(repoPath)`
- Returns parsed JSON array on success
- Returns empty array on failure

### `getIssueDetail(repoPath, issueNumber)`
- Returns parsed issue detail
- Throws on failure (no try/catch in this method)

### `checkStatus()`
- Returns `{ installed: true, authenticated: true, username: "foo" }` when `gh auth status` succeeds
- Returns `{ installed: true, authenticated: false }` when stderr contains "not logged in"
- Returns `{ installed: false, authenticated: false }` when command fails with ENOENT

### `createIssue(title, body, labels)`
- Returns `{ url }` on success with labels
- Retries without labels when first attempt fails, returns `{ url }`
- Returns `null` when both attempts fail

### Error handling
- All fire-and-forget methods (`assignIssue`, `closeIssue`) don't throw on failure

## Files to touch
- `electron/github.test.ts` — new file
