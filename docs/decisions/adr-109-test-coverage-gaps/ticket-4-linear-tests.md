---
title: Add tests for linear.ts
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add tests for linear.ts

Write `electron/linear.test.ts` covering the LinearManager class.

## Mocking strategy

**electron `safeStorage`:**
```typescript
vi.mock("electron", () => ({
  safeStorage: {
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => b.toString().replace("enc:", "")),
  },
}));
```

**`node:fs`:** Mock `readFileSync`, `writeFileSync`, `mkdirSync`, `unlinkSync`, `existsSync` to test token persistence without touching disk.

**`fetch`:** Use `vi.stubGlobal("fetch", vi.fn())` to mock the Linear GraphQL API calls.

## Test cases

### Token management
- `saveToken(key)` encrypts via safeStorage and writes to `linear-token.enc`
- `getToken()` reads and decrypts, returns string
- `getToken()` returns `null` when file doesn't exist
- `clearToken()` deletes the token file
- `clearToken()` doesn't throw when file doesn't exist
- `isConnected()` returns true/false based on token presence

### GraphQL client (`private graphql()` — test via public methods)
- `getViewer()` sends correct query and returns viewer data
- Throws `"Not connected to Linear"` when no token
- Throws on non-OK HTTP response with status info
- Throws on GraphQL errors array
- Throws `"No data returned"` when response has no data field

### Issue operations
- `getMyIssues(teamIds)` returns empty array when teamIds is empty
- `getMyIssues(teamIds)` sends correct query variables, sorts by state type then priority, slices to limit
- `getAllIssues(teamIds)` same pattern
- `getIssueDetail(id)` flattens `labels.nodes` to `labels`

### `autoMatchProjects(projects, teams)` — pure function
- Matches project "manor" to team "Manor"
- Normalizes suffixes: "manor-app" matches team "Manor"
- Returns empty object when no matches
- Case insensitive matching

### Fire-and-forget methods
- `startIssue()` finds "In Progress" state and updates, doesn't throw on failure
- `closeIssue()` finds "Done" state and updates, doesn't throw on failure

## Files to touch
- `electron/linear.test.ts` — new file
