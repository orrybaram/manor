---
title: Store — auto-join toasts, set up / remove-from-host actions
status: in-progress
priority: high
assignee: sonnet
blocked_by: [1]
---

# Store: auto-join toasts, set up / remove-from-host actions

Implement the renderer store parts of ADR-214.

## Steps
1. **`src/store/link-suggestions.ts`: replace suggestion toasts with auto-join.**
   - Wherever suggestions are computed today (the first `loadProjects`, a host's first connect, after `addProject`/`cloneProject`), call `projects.autoJoin()` and reload projects if anything joined.
   - Toasts:
     - Show one toast per joined pair: "Joined <name> on <hostA> with <name> on <hostB>", with an [Undo] action.
     - For three or more pairs, show one summary toast: "Joined N projects across hosts", with an [Undo] that reverts all of them.
     - Undo calls `projects.unlink(joinedId)` and `projects.dismissLinkSuggestion(...)` for the pair (check the dismiss call's signature), then reloads.
   - Delete the Link/Dismiss/Review suggestion toasts and their dead code. Rename the file to `auto-join.ts` if that reads better.
   - Update `src/store/__tests__/link-suggestions.test.ts`, or replace it.
2. **`src/store/project-store.ts`:**
   - Add `setUpOnHost(projectId, hostId, overrides?)`. Implement it as `transferProject(projectId, hostId, "copy", overrides)`, or rename `transferProject` if every caller is copy-only after ticket 3. Keep the `move` path for the repair callers.
   - On a successful set up, give the success toast "<name> is set up on <host>" the action **"Remove from <source host>"**. That action opens the remove-from-host confirm through new store state `removeFromHost: { projectId } | null` and `openRemoveFromHost` / `closeRemoveFromHost`. The confirm itself is ticket 3.
   - Add `removeFromHost(memberId)`, a wrapper over the existing `removeProject` that gives a toast "Removed <name> from <host>".
   - Add `keepSeparate(projectId)`, which calls the new bridge method and reloads.
   - The `cloneIntoGroup` and `linkLocalFolder` callers go away in ticket 4. Leave the functions for now if they are still referenced.
3. Tests: `project-store-transfer.test.ts` covers the success toast's action. Add tests for the auto-join toast and undo.

## Files to touch
- `src/store/link-suggestions.ts` (or its renamed version) and its tests
- `src/store/project-store.ts`
- `src/store/__tests__/project-store-transfer.test.ts`
