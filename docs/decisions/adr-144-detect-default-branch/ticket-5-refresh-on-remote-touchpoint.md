---
title: Refresh origin/HEAD at remote network touchpoints
status: done
priority: medium
assignee: opus
blocked_by: [1, 2]
---

# Refresh origin/HEAD at remote network touchpoints

Follow-up to the startup-resync decision. Startup re-detection is intentionally
local-only (no network) so launch stays fast and offline-safe. The gap that leaves:
an **upstream default-branch rename** is not picked up, because the local
`origin/HEAD` symref only changes via `git remote set-head origin --auto` — a plain
`git fetch` does **not** update an existing `origin/HEAD`.

Rather than pay a network round-trip per project on every launch (with the attendant
credential-prompt / hang risk), refresh `origin/HEAD` at a natural touchpoint where
the app is already doing network git and the user expects latency: `listRemoteBranches`
(invoked when the New Workspace dialog opens, and which already runs `fetch origin --prune`).

## Behavior

In `listRemoteBranches()` (`electron/persistence.ts`), after the existing
`fetch origin --prune` and before the `for-each-ref`:

1. Best-effort `git remote set-head origin --auto` (re-resolves the remote's HEAD symref).
2. Re-detect via `detectDefaultBranchLocal(project.path)`.
3. If it returns a non-empty name differing from `project.defaultBranch`, update and `saveState()`.

The whole block is wrapped in its own try/catch and logs on failure — it must never
block branch listing (which is the method's actual job). No `saveState()` when nothing
changed.

## Files to touch
- `electron/persistence.ts` — add the refresh block inside `listRemoteBranches`.
