---
title: Document the defaultBranch storage invariant
status: done
priority: low
assignee: haiku
blocked_by: []
---

# Document the defaultBranch storage invariant

Record the rule that `defaultBranch` is stored as a bare local branch name and `origin/`
is prepended at use-sites, so future contributors don't reintroduce ambiguity.

## Behavior

In `docs/ARCHITECTURE.md`, add a short note (near the existing ProjectManager / branch
discussion) stating:

> **Default branch.** `project.defaultBranch` is a **bare local branch name** (e.g.
> `main`, never `origin/main`). It is detected from `origin/HEAD` at project creation and
> re-detected at startup (ADR-144). Consumers that need the remote ref prepend `origin/`
> at the use-site (ADR-081) — e.g. diff comparisons and new-worktree base points.

Keep it concise; match the surrounding doc style. Do not touch `electron/persistence.ts`
(the code comment for the invariant is handled in ticket 1).

## Files to touch
- `docs/ARCHITECTURE.md` — add the default-branch invariant note.
