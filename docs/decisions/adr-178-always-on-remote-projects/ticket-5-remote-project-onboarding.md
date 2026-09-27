---
title: Add project on a host — clone and health check
status: done
priority: high
assignee: sonnet
blocked_by: [2]
---

# Add project on a host — clone and health check

**Prerequisite:** ADR-160 tickets 7 (execStream) and 11 (host UI).

Let the user create a project that lives on a remote host (ADR-178 §4).

1. **Main:** `ProjectManager.addRemoteProject({ hostId, repoUrl, remoteDir, name })`:
   validate `repoUrl` (https or scp-style git URL) and `remoteDir` (absolute or `~/`,
   shell-safe charset). Run `git clone <repoUrl> <dir>` via the backend's `execStream`,
   pushing progress on the existing `worktree:setup-progress` channel. Then call the
   normal `addProject` path with `hostId` set (ticket 2 made its reads host-aware).
2. **Health check:** `hostHealthCheck(hostId, projectPath)` runs the four checks in the
   ADR-178 §4 table through the backend and returns `{ id, ok, detail, fixCommand }[]`.
   Treat a missing CLI as "not installed", distinct from "not logged in".
3. **IPC:** `projects:addRemote`, `hosts:healthCheck` in `electron/ipc/projects.ts` and
   `electron/preload.ts`.
4. **UI:** in the add-project flow, an "On a remote host" option: host picker (from
   ADR-160 ticket 11), repo URL, remote directory. After clone, show the health-check
   list; each failed row has a "Fix in terminal" button that opens a terminal tab on
   that host with `fixCommand` typed in (not executed). Re-run button.
   Per `.claude/rules/ui-components.md`: `Button`, `Tooltip`, check `src/components/ui/`
   before any native element.
5. Never copy local credentials or enable ssh agent forwarding. Add a one-line note in
   the UI: "Log in on the box — Manor doesn't copy your keys."

## Files to touch
- `electron/persistence.ts` — `addRemoteProject`.
- `electron/backend/health-check.ts` — new.
- `electron/ipc/projects.ts`, `electron/preload.ts` — IPC.
- `src/components/` — add-project flow (find the existing add-project component), health-check list.
- `src/store/project-store.ts` — action for remote add.
