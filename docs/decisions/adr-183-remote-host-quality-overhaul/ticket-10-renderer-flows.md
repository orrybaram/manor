---
title: Renderer — one clone flow, ProjectHostSection module, remote browser hook
status: done
priority: medium
assignee: sonnet
blocked_by: [9]
---

# Renderer — one clone flow, ProjectHostSection module, remote browser hook

Read `index.md`. Follow `.claude/rules/ui-components.md`, which requires the
components in `src/components/ui/`.

1. **One clone flow.**
   - `AddProjectDialog`'s remote flow and `CloneToHostDialog` are two copies of
     the same form → cloning → health state machine.
   - Add `src/components/hosts/useHostCloneFlow.ts`:
     `useHostCloneFlow({ hostId, run: () => Promise<ProjectInfo> })`. It returns
     `{ step, progressLines, error, checks, checksRunning, start, rerun, fix, reset }`
     and subscribes to `projects.onCloneProgress` from ticket 1.
   - Add a shared `<HostCloneSteps>` for the cloning and health views, and a
     shared `RepoUrl`/`RemoteDir` field group.
   - Each dialog keeps only its own form fields and its `run`:
     `addRemoteProject` or `moveProjectToHost`.
   - Merge the two nearly identical CSS modules.
   - After adding a project, use the returned project, not a store re-lookup.
2. **`ProjectHostSection`.**
   - Move it out of `ProjectSettingsPage.tsx` into
     `src/components/settings/ProjectHostSection/`.
   - Add a `remoteHostOptions(hosts)` helper in `src/lib/hosts.ts`, shared with
     `AddProjectDialog`.
   - Add `isRemoteHost(hostId)` and replace the scattered
     `hostId && hostId !== LOCAL_HOST_ID` checks.
3. **`App.tsx`.** `onRemoteProjectAdded(project)` selects the project by id,
   not `projects[length - 1]`.
4. **`useRemoteBrowserUrl(remoteHostId)`.**
   - Move `BrowserPane.tsx`'s inline remote URL logic into a hook returning
     `{ src, waiting, navigate, onNavigate }`. That logic is `loadedUrl`,
     `waitingForHost`, the sequence refs, the reconnect effect, `sameHost`, and
     the `hostStatus`/`hostLabel` selectors, which should use
     `useHostDisplay`/`selectHost`.
   - Add one shared `resolveUrlForHost(url, hostId)` helper that `PortBadge`'s
     `withResolvedUrl` also uses.

Run `pnpm build` and lint on the touched files.

## Files to touch
- `src/components/hosts/useHostCloneFlow.ts`, `HostCloneSteps.tsx` (new)
- `src/components/sidebar/AddProjectDialog/*`, `src/components/settings/CloneToHostDialog/*`
- `src/components/settings/ProjectSettingsPage.tsx`, `src/components/settings/ProjectHostSection/*` (new)
- `src/lib/hosts.ts`, `src/App.tsx`
- `src/components/workspace-panes/BrowserPane/BrowserPane.tsx`, `src/hooks/useRemoteBrowserUrl.ts` (new), `src/components/ports/PortBadge.tsx`
- sidebar/tabbar/statusbar files that use the `isRemoteHost` check
