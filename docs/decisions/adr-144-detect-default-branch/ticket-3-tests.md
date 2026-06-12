---
title: Tests for default-branch detection and resync
status: todo
priority: medium
assignee: haiku
blocked_by: [1, 2]
---

# Tests for default-branch detection and resync

Add coverage in `electron/persistence.test.ts`. The existing tests already construct
`ProjectManager` with a stubbed/mock git backend (see `new ProjectManager(stubGit, tmpDir)`
and the `gitMock` usage around lines 25 / 279). Follow that pattern — the git stub's
`exec(cwd, args)` should return canned stdout keyed on the args.

## Cases to cover

1. **Detect on creation — non-main default.** Stub `exec` so that
   `symbolic-ref --short refs/remotes/origin/HEAD` returns `origin/master`. Assert
   `addProject(...)` yields `defaultBranch === "master"` (prefix stripped) in the returned
   `ProjectInfo`, and that the persisted state (reload a new `ProjectManager` from the same
   `tmpDir`) also has `"master"`.

2. **Detect on creation — fallback to main.** Stub `exec` so `symbolic-ref` rejects/returns
   empty AND `set-head --auto` also fails. Assert `defaultBranch === "main"`.

3. **Startup resync corrects drift.** Persist a project with `defaultBranch: "main"`
   (e.g. via a manager whose git stub returned nothing useful), then construct a new
   `ProjectManager` whose git stub returns `origin/develop` for `symbolic-ref`. Call
   `getProjects()` and assert the returned project has `defaultBranch === "develop"`, and
   that it was persisted (reload and re-check).

4. **Resync does not clobber on detection failure.** Persist `defaultBranch: "trunk"`,
   then `getProjects()` with a git stub where `symbolic-ref` fails. Assert the value
   stays `"trunk"`.

5. **Resync runs once.** Spy/count `symbolic-ref` invocations across two `getProjects()`
   calls and assert the resync sweep only happened on the first call.

Match the existing test framework/assertions used in the file (vitest-style `describe`/
`it`/`expect`).

## Files to touch
- `electron/persistence.test.ts` — add the cases above, reusing existing stub/mock helpers.
