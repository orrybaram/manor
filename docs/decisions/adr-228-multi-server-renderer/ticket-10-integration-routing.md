---
title: Integrations pick their server per call
status: in-progress
priority: high
assignee: sonnet
blocked_by: [4, 7]
---

# Integrations pick their server per call

ADR-228 D10.

## Do
- **GitHub.** Check that `github.*` follows `byGhRepo` and `byHost` to the
  repo's source in the router. Nothing new should be needed beyond ticket 4.
  Add a router test.
- **Linear server choice.**
  - Add a `linearServerFor(hostId | null)` in `src/bridge/router.ts`, or in
    `src/lib/trackers/linear.ts`. It returns:
    1. the host's source, if that server reports `linear.isConnected()`;
    2. otherwise the desktop that lists the host, if reachable and
       connected;
    3. otherwise a stated refusal.
  - Cache `isConnected` per server, and refresh it on hello and on
    `hosts.pairingChanged`.
  - With no host (browse in `TasksView`): try home first, then any server
    with Linear.
  - Mark the path-free `linear.*` methods in `ROUTES` with a new rule,
    `{by: "delegated", provider: "linear"}`. The router applies the choice
    above, and main's `HostRouting` treats the rule as local.
  - `linkIssueToWorkspace` and `unlinkIssueFromWorkspace` keep `byProject`.
- **Callers.**
  - `src/lib/trackers/linear.ts`, `src/components/sidebar/useIssuesShortcut.tsx`
    and `src/lib/start-issue-work.ts` pass the project's host where they
    have one.
  - `useTrackerStatus` (`src/components/tasks/useTasks.ts:117-146`) reports
    Linear connected if any reachable server has it.
  - When none does, `TasksView` shows the stated reason instead of
    `nothingConnected`, for example "Linear isn't turned on for wsl-box, and
    This Mac is away".
- **Tests:**
  - router unit tests for the three choices;
  - a `TasksView` test for the stated reason.

## Files to touch
- `electron/bridge/routes.ts` (delegated rule),
  `electron/server/host-routing.ts` (treat as local)
- `src/bridge/router.ts`
- `src/lib/trackers/linear.ts`, `src/lib/start-issue-work.ts`,
  `src/components/sidebar/useIssuesShortcut.tsx`
- `src/components/tasks/useTasks.ts`, `src/components/tasks/TasksView.tsx`

## Carried over from ticket 1
- The surface test's `ROUTED_NAMESPACES` lacks `chat` and `linear`. Add them
  (find it with `grep -rn ROUTED_NAMESPACES`) once the delegated rule exists.

## Carried over from ticket 7
- Phone host ids are room ids, or `<desktopRoom>~<hostId>` for a host the
  phone holds no pairing for (`viaServer()`, aliases in
  `src/bridge/server-set.ts`). "The desktop that lists the host" is the
  server whose `lists` covers that id. On the desktop, `local` is home.
