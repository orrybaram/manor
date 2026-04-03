---
title: Wire up IPC handlers and type definitions
status: todo
priority: high
assignee: sonnet
blocked_by: [1, 2]
---

# Wire up IPC handlers and type definitions

Add IPC handlers for the new GitHub issue methods and Linear `getAllIssues`, and update type definitions.

## IPC Handlers (`electron/main.ts`)

Add after the existing `github:checkStatus` handler:

```typescript
ipcMain.handle("github:getMyIssues", (_event, repoPath: string, limit?: number) =>
  githubManager.getMyIssues(repoPath, limit));

ipcMain.handle("github:getAllIssues", (_event, repoPath: string, limit?: number) =>
  githubManager.getAllIssues(repoPath, limit));

ipcMain.handle("github:getIssueDetail", (_event, repoPath: string, issueNumber: number) =>
  githubManager.getIssueDetail(repoPath, issueNumber));
```

Add after the existing `linear:getIssueDetail` handler:

```typescript
ipcMain.handle("linear:getAllIssues", (_event, teamIds: string[], options?: { stateTypes?: string[]; limit?: number }) =>
  linearManager.getAllIssues(teamIds, options));
```

## Preload (`electron/preload.ts`)

Extend the `github` object:

```typescript
getMyIssues: (repoPath: string, limit?: number) =>
  ipcRenderer.invoke("github:getMyIssues", repoPath, limit),
getAllIssues: (repoPath: string, limit?: number) =>
  ipcRenderer.invoke("github:getAllIssues", repoPath, limit),
getIssueDetail: (repoPath: string, issueNumber: number) =>
  ipcRenderer.invoke("github:getIssueDetail", repoPath, issueNumber),
```

Extend the `linear` object:

```typescript
getAllIssues: (teamIds: string[], options?: { stateTypes?: string[]; limit?: number }) =>
  ipcRenderer.invoke("linear:getAllIssues", teamIds, options),
```

## Type Definitions (`src/electron.d.ts`)

Add interfaces:

```typescript
export interface GitHubIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  labels: Array<{ name: string; color: string }>;
  assignees: Array<{ login: string }>;
}

export interface GitHubIssueDetail extends GitHubIssue {
  body: string | null;
  milestone: { title: string } | null;
}
```

Extend `ElectronAPI.github`:

```typescript
getMyIssues: (repoPath: string, limit?: number) => Promise<GitHubIssue[]>;
getAllIssues: (repoPath: string, limit?: number) => Promise<GitHubIssue[]>;
getIssueDetail: (repoPath: string, issueNumber: number) => Promise<GitHubIssueDetail>;
```

Extend `ElectronAPI.linear`:

```typescript
getAllIssues: (teamIds: string[], options?: { stateTypes?: string[]; limit?: number }) => Promise<LinearIssue[]>;
```

## Files to touch
- `electron/main.ts` — add 4 IPC handlers
- `electron/preload.ts` — add 4 bridge methods
- `src/electron.d.ts` — add GitHub issue types and extend both `github` and `linear` API surfaces
