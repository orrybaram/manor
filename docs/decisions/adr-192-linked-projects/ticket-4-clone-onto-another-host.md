---
title: "\"Clone onto another host…\" from the host picker, linked automatically"
status: done
priority: medium
assignee: sonnet
blocked_by: [3]
---

# "Clone onto another host…" from the host picker, linked automatically

GitHub issue #247. See ADR-192 §5.

- The picker offers "Clone onto another host…", listing only hosts with no member in the group.
- It launches the existing clone flow (`useHostCloneFlow` / `CloneToHostDialog` / `addRemoteProject`).
- When the clone succeeds, call `linkProjects(newProjectId, groupMemberId)` and continue the dialog with that host selected.
- A cancelled or failed clone leaves the group unchanged.
- A test goes through the project-store seam: linking after a clone.

## Files to touch
- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx`
- `src/store/project-store.ts`

## As built
- "Clone onto another host…" is a button beside the picker, not a picker option, because the picker is a radio group of members. It opens `CloneToHostDialog` in a new `addToGroup` mode, which lets the user choose among the hosts `hostsToCloneOnto` offers.
- The store action `cloneIntoGroup(memberId, opts)` does the clone and the link. It calls the `addRemote` and `link` IPCs directly instead of `addRemoteProject` and `linkProjects`, so the new project doesn't show up (or take the sidebar selection) unlinked first. Then it reloads. If the link fails, a toast says so and the clone stays as an unlinked project. The dialog then keeps its current host (`memberAfterClone`).
