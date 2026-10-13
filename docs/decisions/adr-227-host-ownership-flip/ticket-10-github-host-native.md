---
title: GitHub runs host-native on the host server
status: done
priority: high
assignee: sonnet
blocked_by: [5, 8]
---

# GitHub runs host-native on the host server

ADR-227 D7 (GitHub).

## Do
- **Host composition.** Compose `new GitHubManager()` with no resolver on the
  host (via `createManorServer`). `ghTarget` then runs `gh` with
  `cwd: path`, using the box's own sign-in (`electron/github.ts:173-191`).
- **`HOST_TABLE` allows `github.*`:**
  - `getPrsForBranches`, `listRepos`, `getViewerName`, `checkStatus`
  - `getMyIssues`, `getAllIssues`, `getIssueDetail`
  - `assignIssue`, `closeIssue`, `createIssue`
  - `proxyImage`
  
  Leave out `uploadFeedbackImages`; it is the desktop's feedback flow.
- **Desktop routing.** Route the desktop's `github.*` methods that take a
  `GhRepo` with `byGhRepo` (ticket 8's rule). A remote repo's calls then run
  on its host. Delete the desktop's `RemoteRepoResolver` wiring
  (`electron/app-lifecycle.ts:376-383`); `GitHubManager` on the desktop
  becomes resolver-free.
- **Renderer empty state.** When `github.checkStatus` reports not installed
  or not authenticated for a host, show **"gh isn't signed in on \<host\>"**
  as a stated empty state, not an error, in:
  - the issues panel
  - the PR badge area (`src/hooks/usePrWatcher.ts:85`, which currently
    swallows errors)
- **PATH on the box.** The host server is spawned from the login shell, so
  `gh` should be on PATH. Log `which gh` at startup.
- **Tests:**
  - host table allows `github.*` (update the `boot-and-agents.test.ts`
    unavailable list);
  - `GitHubManager` with no resolver runs `gh` in cwd, using the
    `installFakeGh` fixture (`tests/e2e/helpers/fake-gh.ts`) or a stub exec.

## Files to touch
- `electron/server/create-manor-server.ts`
- `electron/host-server/handlers.ts`
- `electron/bridge/handlers/integrations.ts`
- `electron/github.ts`
- `electron/app-lifecycle.ts`
- `src/hooks/usePrWatcher.ts`
- `src/lib/trackers/github.ts`
- the issues panel component that shows tracker status
- `electron/host-server/__tests__/boot-and-agents.test.ts`

## Carried over from ticket 8

All `github.*` methods are marked `LOCAL_ROUTE` with a comment pointing here. `byGhRepo` is declared in `electron/bridge/method.ts` and resolved in `electron/server/host-routing.ts`, but nothing uses it yet. Switch the `GhRepo` methods to `byGhRepo(...)`; `electron/bridge/__tests__/routes-surface.test.ts` will then require them on the host table.
