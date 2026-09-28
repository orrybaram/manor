---
title: GitHub cache and portless hostnames separated by host
status: todo
priority: low
assignee: sonnet
blocked_by: [1]
---

# GitHub cache and portless hostnames separated by host

GitHub issue #243. See ADR-191 §6.

- `electron/github.ts`: key `remoteRepoCache` by the workspace key, not the
  bare `repoPath`. Where the caller knows the host, pass it and use it for the
  `gh -R` decision in `electron/app-lifecycle.ts` instead of
  `hostIdForPath(repoPath)`.
- `electron/portless.ts` and `electron/ipc/ports.ts`: for a non-local host,
  add a host segment derived from the host's name. Local hostnames stay
  byte-for-byte the same.
- Tests: the repo cache keeps separate entries for the same path on two
  hosts. A local main and a remote main of the same project get distinct,
  working hostnames. Extend the portless gate tests.

## Files to touch
- `electron/github.ts`, `electron/app-lifecycle.ts` and their tests.
- `electron/portless.ts`, `electron/ipc/ports.ts` and the portless tests.
