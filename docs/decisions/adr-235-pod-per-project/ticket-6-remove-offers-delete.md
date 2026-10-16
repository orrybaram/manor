---
title: Remove Project / Remove from host offer to delete the project's pod
status: todo
priority: high
assignee: sonnet
blocked_by: [5]
---

# Remove Project / Remove from host offer to delete the project's pod

ADR-235 D6.

- In `RemoveProjectDialog.tsx` and `RemoveFromHostDialog.tsx`, when the
  removed member's host has `forProject === memberId` and
  `capabilities.canDestroy`, show a checkbox:
  - label "Also delete its pod and disk" ("its container and volume" for a
    docker-template host);
  - **checked** by default;
  - "There is no undo." beneath it.
- Checked: `removeProject(id)`, then `host-store.removeHost(hostId, true)`.
  If the destroy fails, keep the project removed and show a toast: "Couldn't
  delete <host>'s pod" [Open Hosts settings]. The host stays in `error`.
- Unchecked: `removeProject(id)`, then `hosts.stop(hostId)` (add the IPC if
  only the registry has `stop`), then clear `forProject` (new
  `hosts.setForProject(hostId, null)` or part of ticket 5's plumbing).
- For Remove Project on a group with several pod members, apply this to each
  member whose host is its own.
- Tests for both dialogs.

## Files to touch
- `src/components/sidebar/RemoveProjectDialog.tsx`
- `src/components/sidebar/RemoveFromHostDialog.tsx`
- `src/store/project-store.ts`, `src/store/host-store.ts`
- `electron/bridge/handlers/hosts.ts` — `stop` / `setForProject` if missing
