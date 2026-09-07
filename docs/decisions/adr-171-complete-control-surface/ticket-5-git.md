---
title: Git routes and a git tool module
status: done
priority: high
assignee: sonnet
blocked_by: [1, 2]
---

# Git routes and a git tool module

Thin wrappers over `backend.git` (`GitBackend` in `electron/backend/types.ts`). Every route takes `cwd` in the body/query and `400`s if it is not a known workspace path of some project (check `projectManager.getProjects()`); this is the only guard against running git in arbitrary directories.

## Routes — new `electron/routes/git.ts`, prefix `/git`

| Method | Path                               | Body                                      | Calls                                                                                                                                                                                          |
| ------ | ---------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/git/stage`                       | `{ cwd, files: string[] }`                | `stage`                                                                                                                                                                                        |
| POST   | `/git/unstage`                     | `{ cwd, files }`                          | `unstage`                                                                                                                                                                                      |
| POST   | `/git/discard`                     | `{ cwd, files }`                          | `discard` (description: destructive, no confirm)                                                                                                                                               |
| POST   | `/git/stash`                       | `{ cwd, files }`                          | `stash`                                                                                                                                                                                        |
| POST   | `/git/commit`                      | `{ cwd, message, flags?: string[] }`      | `commit`                                                                                                                                                                                       |
| POST   | `/git/push`                        | `{ cwd, remote?, branch?, setUpstream? }` | `pushStream`; collect `onLine` output, resolve on `onDone`, respond `{ exitCode, lines, stderr }`; `AbortSignal`-style timeout of 5 min cancels via the returned `cancel()` and responds `504` |
| GET    | `/git/staged-files?cwd=`           | —                                         | `getStagedFiles`                                                                                                                                                                               |
| GET    | `/git/diff?cwd=&scope=local\|full` | —                                         | `getLocalDiff` or `getFullDiff(cwd, project.defaultBranch)` (look the project up by `cwd`)                                                                                                     |

Register `gitRoutes` in `routes/index.ts`.

## Tools — new `electron/mcp/tools-git.ts`

`git_stage`, `git_unstage`, `git_discard`, `git_stash`, `git_commit`, `git_push`, `git_staged_files`, `git_diff` (`scope` enum). `cwd` defaults through `resolveWorkspacePath`. `git_push` prints the collected lines. Add `gitModule` to `electron/mcp/modules.ts` with label `git` (after `sessions`).

## Tests

- `electron/routes/git.test.ts`: fake `backend.git`; commit forwards message/flags; push collects lines and exit code; unknown `cwd` → 400; `diff?scope=full` uses the project's default branch.

## Files to touch

- `electron/routes/git.ts` — new
- `electron/routes/git.test.ts` — new
- `electron/routes/index.ts` — register
- `electron/mcp/tools-git.ts` — new
- `electron/mcp/modules.ts` — add module + label
