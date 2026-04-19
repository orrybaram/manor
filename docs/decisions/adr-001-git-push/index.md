---
type: adr
status: proposed
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

# ADR-001: Push to Remote from Diff Tab

## Context

The DiffPane already supports staging, committing, discarding, and stashing changes. However there is no way to push committed changes to the remote from within the app — users must drop to a terminal to run `git push`. This is a friction point in the commit-then-push workflow.

## Decision

Add a `push` method to the `GitBackend` interface and wire it end-to-end: backend implementation → IPC handler → preload exposure → a Push button in the DiffPane top bar.

**Backend**: `LocalGitBackend.push(cwd, remote?, branch?)` runs `git push [remote] [branch]` with a 60s timeout. Remote defaults to `origin`; branch defaults to the current branch (via `git rev-parse --abbrev-ref HEAD`). Errors are surfaced as thrown `Error` with cleaned stderr.

**IPC**: New `git:push` handler in `electron/ipc/branches-diffs.ts`, matching the existing `git:commit` pattern. Accepts `wsPath`, optional `remote`, optional `branch`.

**Preload**: `electronAPI.git.push(wsPath, remote?, branch?)` exposed via `contextBridge` alongside existing git methods.

**UI**: A "Push" `<Button variant="secondary">` added to the DiffPane top bar, next to the Commit button. Button shows a loading spinner while pushing. On error, an inline error message appears below the top bar (same pattern the CommitModal uses for errors). Button is always enabled — if there's nothing to push, git exits cleanly.

## Consequences

- **Better**: Users can complete the full stage → commit → push workflow without leaving the app.
- **Risk**: `git push` can require credentials (SSH passphrase, HTTPS password). If the remote requires interactive auth that can't be resolved from the environment, push will time out or fail. Error message will surface to the user clearly.
- **No change** to existing commit flow or other git operations.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
