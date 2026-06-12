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

# ADR-144: Detect the project's true default branch from origin

## Context

The project's `defaultBranch` is **hardcoded to `"main"`** at project creation —
`electron/persistence.ts:180` (persisted `PersistedProject`) and `:233` (the
`ProjectInfo` returned to the renderer). There is no detection of the repository's
real upstream default branch anywhere: no `git symbolic-ref refs/remotes/origin/HEAD`,
no `git remote show origin`, no `origin/HEAD` reference in `electron/` or `src/`.

This single string is load-bearing. It seeds:

- New Workspace dialog base-branch options — `NewWorkspaceDialog.tsx:80` and the
  `allBranchOptions` list at `:104-113` (local default, `origin/{default}`, then other
  `origin/*`).
- Diff comparisons (`DiffPane`, `diff-watcher.ts` compare against `origin/<defaultBranch>`).
- Merge targets and Quick Merge (`persistence.ts` merge ops; `workspace-actions.ts`).
- The "Convert to Workspace" affordance (`ProjectItem.tsx`, gated on
  `ws.branch !== project.defaultBranch`).

So any repo whose upstream default is not literally `main` (`master`, `develop`,
`trunk`, …) is silently mishandled across all of the above. The field is read-only in
Project Settings (`ProjectSettingsPage.tsx:271`, `fieldStatic`) and is not in
`ProjectUpdatableFields`, so today there is no way to even correct it.

Because `defaultBranch` is always persisted (always written as `"main"`), presence /
absence of the value cannot distinguish "never detected" from "genuinely main". That
rules out a "skip resync if unrecorded" heuristic — and we don't need one: with the
field staying read-only there is no user override to protect.

This ADR **extends** prior decisions; it does not replace them:

- **ADR-081** — base new worktrees off `origin/<defaultBranch>` (use-time behavior).
- **ADR-092** — New Workspace dialog redesign; base-branch option ordering.
- **ADR-065** — create workspaces from remote-only branches.

All of those prepend `origin/` at use-sites; none of them establish what
`defaultBranch` actually *is*. That gap is what this ADR closes.

## Decision

**1. Detect on project creation.** Add a `detectDefaultBranch(repoPath)` helper in
`electron/persistence.ts` and call it from `addProject()`, replacing the hardcoded
`"main"` at both `:180` and `:233`. Detection order (all local, no network fetch
required — `origin/HEAD` is a local ref):

1. `git symbolic-ref --short refs/remotes/origin/HEAD` → yields `origin/<name>`; strip
   the `origin/` prefix to get the bare branch name.
2. If unset, `git remote set-head origin --auto` then retry step 1 (this resolves
   `origin/HEAD` from the remote; one cheap network round-trip, best-effort).
3. Fall back to `"main"` only if everything fails (no remote, detached, offline).

**2. Re-detect at startup as a failsafe.** Add `resyncDefaultBranches()` to
`ProjectManager`. It iterates persisted projects, re-detects each project's default
(local `symbolic-ref` only — no `set-head`/fetch, so it is fast and offline-safe),
updates any that changed, and saves. It runs **once per session**, triggered lazily on
the first `getProjects()` call (guarded by a `private resyncDone` flag) so the renderer's
first `projects:getAll` already sees corrected values without a new IPC push event.

Because the field is read-only (no user override), unconditional re-detection is safe:
it auto-corrects existing projects stuck on `"main"` (drift) **and** picks up the case
where origin's default changes later. Detection failures leave the stored value
untouched (never clobber a good value with a fallback).

**3. Keep the Project Settings field read-only — but truthful.** No UI change:
`ProjectSettingsPage.tsx` keeps rendering `defaultBranch` as a static field. The value
it shows is now detection-driven instead of a hardcoded lie. Manual override (a future
"Override default branch" checkbox revealing a type-ahead picker over local + `origin/*`
branches) is explicitly **deferred** — we design so as not to prevent it, but do not
build it here.

**4. Document the storage invariant.** `defaultBranch` is stored as a **bare local
branch name**; `origin/` is prepended at use-sites (per ADR-081). Record this in
`docs/ARCHITECTURE.md` and as a code comment near the field. Storing explicit
local-vs-remote intent is out of scope.

## Consequences

**Better**
- Repos with non-`main` defaults work correctly across diffs, merges, workspace
  creation, and the Convert-to-Workspace affordance.
- Existing projects self-heal on next launch with no migration step or user action.
- Tracks upstream default-branch renames automatically.

**Costs / risks**
- `addProject` may make one best-effort network round-trip (`set-head --auto`) when
  `origin/HEAD` is unset; guarded by try/catch and a `"main"` fallback so it never
  blocks creation.
- Startup `getProjects()` does N local `symbolic-ref` calls (one per project) on first
  invocation. These are cheap and local, but we run them once per session, not per call.
- Unconditional resync means a manual override is impossible until the deferred
  checkbox lands — accepted by design (the repo default is the standard).

**Non-goals (possible future work)**
- Manual/local override of the default branch.
- Offering local-only (non-default) branches as base options in New Workspace
  "new branch" mode for WIP fork-points. Current `allBranchOptions`
  (`NewWorkspaceDialog.tsx:104-113`) intentionally offers only local default + `origin/*`;
  the local/origin optionality from ADR-092 is preserved as-is.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
