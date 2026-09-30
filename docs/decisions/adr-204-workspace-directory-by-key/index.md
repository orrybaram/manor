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

# ADR-204: A workspace directory addressed by WorkspaceKey

Finishes ADR-191. Candidate 3 of the 2026-09-30 architecture review.

## Context

ADR-191 made a workspace's identity *host + path* (`WorkspaceKey`,
`src/lib/workspace-key.ts`). Layouts, panes and `/context` follow it, but the
per-workspace state that watchers fill in still goes by path alone:

- **Store patching.** `updateWorkspaceBranch`, `updateWorkspaceDiffStats` and
  `updateWorkspacePr` (`src/store/project-store.ts`) take a path and patch
  *every* project with a workspace at that path. A local and a remote project
  of the same repo, under the same username, share paths, so one host's PR,
  branch or diff stats land on the other's workspace too.
- **Carry-over on reload.** `keepWatchedState` indexes the previous project
  list `byPath`; the last project with the path wins, so a reload can move a
  PR from one host's workspace to the other's.
- **Watcher payloads.** `BranchWatcher` and `DiffWatcher`
  (`electron/branch-watcher.ts`, `electron/diff-watcher.ts`) scan per host but
  merge the hosts' results into one `Record<path, …>` with `Object.assign`,
  so a same-path collision is lost in main before the renderer sees it.
  `DiffWatcher` also keys `defaultBranches` and `nonGitPaths` by path.
- **Scattered lookups.** Finding "the project for this workspace" is spread
  over `projectForWorkspace`, `projectForWorkspaceKey`, `hostIdForWorkspace`,
  `workspaceHostId` (`src/lib/hosts.ts`) and `ownerHostIdForPath`
  (`workspace-key.ts`), plus about 14 inline
  `projects.find(p => p.workspaces.some(w => w.path === …))` scans across
  all projects, most of which have the host at hand (`activeWorkspaceHostId`,
  a pane's key, a port's `hostId`). `projectForWorkspace` and
  `hostIdForWorkspace` have no callers outside `hosts.ts`.
- `src/lib/host-id.ts` is 19 lines that exist only so `electron/` can import
  `LOCAL_HOST_ID` without DOM types; `workspace-key.ts` is already pure and
  imported by both sides.

This is the same class of bug as the earlier ADR-191 follow-ups 6d2aba00,
26d22401 and b39448c7, each fixed at one call site.

## Decision

### 1. One pure module: `src/lib/workspace-directory.ts`

Indexes projects by `WorkspaceKey`. Pure data in, data out; no store, no
`window`. Generic over a minimal project shape (`id`, `path`, `hostId`,
`workspaces: { path }[]`) so tests use plain literals.

```ts
keyOf(project, workspace): WorkspaceKey
find(projects, key): { project, workspace, index } | undefined
ownerOf(projects, key): P | undefined          // replaces projectForWorkspaceKey
patch(projects, key, fn: (ws) => ws): P[]      // same array back when fn returns ws unchanged
reconcile(fresh, previous): P[]                // keepWatchedState: pr/diffStats carried by key + branch
hostForPath(selection, path): HostId | undefined // the one path-only fallback (was workspaceHostId)
```

- `patch` touches only the project on the key's host. When `fn` returns the
  same workspace object it returns the same `projects` array, which is what
  lets `updateWorkspaceDiffStats` keep subscribers quiet (the old
  `changed` flag) and gives the other two the same no-op behaviour.
- `ownerOf` keeps `projectForWorkspaceKey`'s semantics: the project's main
  checkout path counts as well as its listed workspaces.
- `reconcile` carries `pr` and `diffStats` over only when both the key and
  the branch match (`branchesEqual`).
- `hostForPath` is the renamed `workspaceHostId` (Home is local; the
  selected project wins a tie). It stays only for callers that genuinely
  receive a bare path (see §4) and says so in its doc comment.

### 2. Store actions take a key

`updateWorkspaceBranch(key, branch)`, `updateWorkspaceDiffStats(key, stats)`,
`updateWorkspacePr(key, pr)` become one-liners over `patch`, with the
equality checks (`branchesEqual`, diff-stat equality, `prEqual`) inside the
patch function. `keepWatchedState` is replaced by `reconcile`. The
`createWorktree`/`removeWorktree` actions are not restructured (ADR-203's
territory); they keep calling the carry-over under its new name.

### 3. Watchers speak keys end to end

- Main: `BranchWatcher` and `DiffWatcher` key their scan results (and
  `DiffWatcher`'s `defaultBranches` / `nonGitPaths`) by
  `workspaceKey(hostId, path)`. A local workspace's key is its bare path, so
  the payload shape is unchanged for local-only users. The IPC channel types
  in `preload.ts` / `electron.d.ts` say `Record<WorkspaceKey, …>`.
- Renderer: `useBranchWatcher` / `useDiffWatcher` pass the payload key
  straight through; `useDiffWatcher`'s workspace map is keyed by key.
  `usePrWatcher` calls `updateWorkspacePr(keyOf(project, ws), pr)`.

### 4. Lookup call sites move to keys

Converted (host is known at the call site):

| Call site | Host from |
|---|---|
| `StatusBar.tsx`, `useCommands.tsx` (active project, copy-branch), `keybinding-commands.ts` (`resolveWorkspaceCommand`, copy-branch), `IssueDetailView.tsx`, `GitHubIssueDetailView.tsx`, `WorkspaceSetupView.tsx` | `selectActiveWorkspaceKey` |
| `agent-defaults.ts` `getAgentCommand` | takes a `WorkspaceKey`; callers pass the active key, `agent-prompt-launch` its own key |
| `useTerminalLifecycle.ts` (two cwd lookups) | the hook's `workspaceKey` param; cwd lookups use the key's host |
| `DiffPane.tsx` | its `hostId` prop |
| `PortGroup.tsx` | the group's ports' `hostId` |
| `app-commands.ts` `projectsKnowWorkspace` | the command's `hostId` arg |
| `command-palette/scope.ts` | takes `activeWorkspaceKey` |

`useCustomCommands.tsx` has no callers and is deleted. Lookups inside one
already-known project (`ProjectItem`, `workspace-actions`, `LinkedIssuesPopover`,
`ProjectTiles`, …) are unambiguous and stay as they are.

**Not converted, and why:**

- `migrateWorkspaceKey` / `ownerHostIdForPath`: migrates pre-ADR-191 data,
  which has no host by definition.
- `PathRouter.hostIdForPath` and `routes/git.ts` `resolveProjectByPath`
  (main): the HTTP/pty requests carry only a cwd. Fixing them means adding a
  host to those APIs; out of scope.
- `layoutKeyFor` and `startSetupScript` fallbacks (`hostForPath`): the
  control-server commands (`app-commands.ts`) take an optional `hostId`, so
  a bare path can still arrive. Making `hostId` required on those commands is
  a follow-up.
- `worktreeSetupState` in `app-store.ts` is keyed by bare path; re-keying
  that state is a follow-up. `WorkspaceSetupView` uses the active key meanwhile.
- `home-dashboard*.ts`, `tasks.ts`, `TasksView.tsx`: owned by sibling work
  (PR verdict, task list). `home-dashboard.ts` keeps importing
  `projectForWorkspaceKey`, which stays in `hosts.ts` as a re-export of
  `ownerOf` until that work lands; then the re-export is removed.

### 5. `host-id.ts` folds into `workspace-key.ts`

`HostId`, `LOCAL_HOST_ID` and `normalizeHostId` move into `workspace-key.ts`
(already pure and shared with `electron/`). `host-id.ts` is deleted and its
~10 importers re-pointed. `hosts.ts` loses `projectForWorkspace`,
`hostIdForWorkspace`, `workspaceHostId` and `hasWorkspace`, keeping host
labels, health-check types and URL helpers.

## Consequences

- The same-path-on-two-hosts mix-up for PR, branch and diff stats becomes
  impossible at the store: there is no path-only patch left to call.
- One place to read "which workspace is this key", and one documented
  path-only fallback instead of four helpers.
- Tests move to the module's interface as plain data: "same path on two
  hosts, patching one leaves the other alone", "reconcile keeps the PR only
  when key and branch match". They replace
  `project-store-refresh-keeps-pr`, `project-store-diff-stats`,
  `project-store-pr-equality` and the path-only parts of `hosts.test.ts`.
  The watcher tests in `electron/` gain a two-host same-path case.
- Remote workspaces' watcher payload keys change from `/a/b` to `box:/a/b`.
  Only the renderer hooks consume those channels, and they change together.
- Risk: `find`/`ownerOf` rebuild nothing, they scan (projects × workspaces is
  small). No cached index to go stale.
- Leftovers are listed in §4; each needs an API or state-shape change owned
  elsewhere.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
