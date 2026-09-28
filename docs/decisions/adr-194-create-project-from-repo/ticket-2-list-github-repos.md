---
title: List the user's GitHub repos via gh
status: todo
priority: medium
assignee: sonnet
blocked_by: []
---

# List the user's GitHub repos via gh

See ADR-194 §2.

- `electron/github.ts`: `GitHubManager.listRepos(): Promise<GitHubRepo[]>`.
  Run `gh api "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member" --paginate`
  with the same exec options/env pattern the other `gh` calls in this file use.
  `--paginate` concatenates JSON arrays (`][`); use `--jq '.[] | {...}'` to
  emit one JSON object per line and parse lines. Map to
  `{ nameWithOwner: full_name, description, private, sshUrl: ssh_url, httpsUrl: clone_url, pushedAt: pushed_at, cloneUrl }`.
  `cloneUrl` = `sshUrl` if `gh config get git_protocol` prints `ssh`, else
  `httpsUrl` (look up once per call). Sort by `pushedAt` desc.
  Cache for 5 minutes. Any failure (gh missing, not authed) → `[]`, logged, not thrown.
- Register `github:listRepos` in the IPC module where other `github:*`
  handlers live; expose `github.listRepos()` in `electron/preload.ts` and the
  renderer type; export the `GitHubRepo` type for the renderer the same way
  other GitHub types are shared.
- Unit test the line parsing / protocol choice with a stubbed exec, following
  existing `github` tests.

## Files to touch
- `electron/github.ts` (+ test)
- the `github:*` IPC registration file
- `electron/preload.ts` and renderer `electronAPI` typing
