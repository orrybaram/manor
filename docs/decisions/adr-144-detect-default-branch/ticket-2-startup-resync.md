---
title: Re-detect default branch at startup (drift failsafe)
status: in-progress
priority: high
assignee: sonnet
blocked_by: [1]
---

# Re-detect default branch at startup (drift failsafe)

Auto-correct existing projects whose stored `defaultBranch` is stale (e.g. stuck on
`"main"` from before detection existed, or origin's default was renamed). Safe to do
unconditionally because the field is read-only — there is no user override to clobber.

## Behavior

Add a public method `resyncDefaultBranches(): Promise<void>` to `ProjectManager` in
`electron/persistence.ts`:

- Iterate `this.state.projects`.
- For each project, re-detect using a **local-only** detection: run
  `git symbolic-ref --short refs/remotes/origin/HEAD` directly (do NOT call
  `set-head --auto`/fetch here — startup must stay fast and offline-safe). Reuse the
  ticket-1 `detectDefaultBranch` helper but in a mode that skips the network step, OR
  factor the local `symbolic-ref` read into a small shared `detectDefaultBranchLocal()`
  helper that both `detectDefaultBranch` (step 1) and `resyncDefaultBranches` call.
  Strip the `origin/` prefix as in ticket 1.
- If detection returns a non-empty name that differs from `project.defaultBranch`,
  update it. If detection fails/empty, leave the existing value untouched (never
  overwrite a good value with a fallback).
- If any project changed, call `this.saveState()` once at the end.
- Wrap per-project detection in try/catch so one bad repo can't abort the sweep.

Trigger it **once per session, lazily on first `getProjects()`**:
- Add `private resyncDone = false;`
- At the top of `getProjects()`, if `!this.resyncDone`, set `this.resyncDone = true`
  and `await this.resyncDefaultBranches()` before building project info. This guarantees
  the renderer's first `projects:getAll` returns corrected values without needing a new
  IPC push event. Subsequent `getProjects()` calls skip the resync.

## Files to touch
- `electron/persistence.ts` — add `resyncDefaultBranches()` (and the local-only detection
  helper if factoring it out), add the `resyncDone` guard, and invoke the resync at the
  start of `getProjects()`.
