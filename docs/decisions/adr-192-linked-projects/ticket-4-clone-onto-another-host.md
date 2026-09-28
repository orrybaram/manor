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
- "Clone onto another host…" is a button beside the picker, not a picker option, because the picker is a radio group of members. It opens `CloneToHostDialog` (moved to `src/components/hosts/`) in a new `addToGroup` mode. There the user chooses among the hosts `hostsToCloneOnto` offers.
- `hostsToCloneOnto` offers only registered hosts, and those are always remote, so `local` is never offered. Every clone path (`projects:addRemote`) clones over SSH onto a remote host, and there is no flow that clones onto this machine. A host whose last connect failed (`error`) is shown disabled, with the reason. Disconnected, connecting and reconnecting hosts stay offered, because `projects:addRemote` connects the host before cloning, and a host with no project on it usually sits disconnected.
- The store action `cloneIntoGroup(memberId, opts)` does the clone and the link, then reloads. It calls the `addRemote` and `link` IPCs directly instead of `addRemoteProject` and `linkProjects`, so the new project doesn't show up (or take the sidebar selection) unlinked first. On success it clears link suggestions naming either project (ticket 5). If the link fails, a toast says so, the clone stays as an unlinked project with link suggestions offered for it, and the dialog keeps its current host (`memberAfterClone`).
