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

# ADR-179: Clone an existing project onto a remote host

## Context

ADR-160/178 let a project live on a remote host. There are two ways to get a
project there today:

1. **Add Project → "On a remote host"** (ADR-178 ticket 5) clones a repo onto the
   box and creates a *new* project record whose `path` is on the host.
2. **Project Settings → Host** (ADR-160 ticket 11) switches an *existing*
   project's `hostId`, and nothing else.

Path 2 is broken for the common case. Moving the `gary` project to `wsl-box`
left `path: /Users/orrybaram/Code/gary`, a Mac path that does not exist on the
Linux box. Every terminal the remote daemon spawns exits immediately with
`chdir(2) failed.: No such file or directory` (seen in the session's
`scrollback.bin` on the box), and worktree creation fails because host-side
`git -C <path>` has no repo. The project also carried an absolute local
`worktreePath` (`/Users/orrybaram/.manor/worktrees/gary`), which is equally
meaningless on the host.

`projects:update` (`electron/ipc/projects.ts`) only checks that the host is
registered, so the settings UI can put a project into this state with no
warning.

## Decision

Moving an existing project to a remote host becomes a **clone-onto-host**
operation that updates the *same* project record (id, name, color, commands,
agent settings, and Linear associations are all kept).

### Main process (`electron/persistence.ts`, `electron/ipc/projects.ts`)

- Extract the clone/adopt part of `ProjectManager.addRemoteProject` into a
  private `prepareRemoteClone(hostId, repoUrl, remoteDir): Promise<string>`.
  It validates inputs, resolves `~` against the host home, adopts a directory
  that is already a clone of `repoUrl`, refuses a non-empty unrelated directory,
  and otherwise clones with the existing `"clone"` setup-progress events. It
  returns the absolute target dir. `addRemoteProject` keeps its behaviour on top
  of it.
- New `ProjectManager.moveProjectToHost(projectId, { hostId, repoUrl, remoteDir })`:
  - rejects the local host, and rejects a target `(hostId, dir)` that another
    project already owns;
  - calls `prepareRemoteClone`;
  - sets `hostId` and `path = targetDir`; re-detects `defaultBranch` through the
    host's git;
  - rekeys the old main path to `targetDir` in every path-keyed field
    (`workspaceNames`, `workspaceOrder`, `workspaceIssues`, `workspaceHidden`,
    `workspaceFolderIds`), so the main workspace keeps its name ("main"),
    order, folder and issues;
  - resets `worktreePath` to `null` unless it starts with `~`, because an
    absolute path from the old machine is meaningless on the host. `null`
    resolves to `<hostHome>/.manor/worktrees/<slug>` (ADR-178 §3);
  - saves and returns the rebuilt `ProjectInfo`.
- New `ProjectManager.getOriginUrl(projectId): Promise<string | null>`:
  `git remote get-url origin` through the project's current host, or `null` on
  any failure. It pre-fills the repo URL.
- New `ProjectManager.projectPathExists(projectId): Promise<boolean>`, which
  checks through the project's host (`fs.existsSync` locally, `remoteFileExists`
  remotely).
- IPC: `projects:moveToHost` (it `await`s `backendRegistry.ensureConnected`
  first, as `projects:addRemote` does), `projects:getOriginUrl`,
  `projects:pathExists`.
- **Guard.** `projects:update` with a `hostId` that differs from the current
  one checks that the project's `path` exists on the target host. If it does
  not, the update throws `Project path "<path>" does not exist on <target>.
  Clone it onto the host instead.` A bare host switch therefore still works
  when the repo really is at the same path on both machines, and can no longer
  silently break a project.

### Renderer

- Extract the clone progress log and health-check list from
  `AddProjectDialog` into shared components under `src/components/hosts/`
  (`CloneProgressLog`, `HealthCheckList`) and use them in both places.
- New `CloneToHostDialog` (`src/components/settings/CloneToHostDialog/`) with
  the same form → cloning → health steps as the remote Add Project flow. It is
  pre-filled with the repo URL from `getOriginUrl` and a remote dir of
  `~/code/<project-slug>`, and calls a new `projectStore.moveProjectToHost`.
- `ProjectHostSection` (`ProjectSettingsPage.tsx`):
  - choosing a remote host, including one just added with "Add new host…",
    opens `CloneToHostDialog` for that host instead of switching straight away.
    The existing "project has open panes" confirm still runs first;
  - choosing Local stays a plain `updateProject({ hostId })`, so it goes
    through the guard;
  - for a project already on a remote host, a `pathExists` check runs on mount
    and after the host connects. When the path is missing it shows
    "Repository not found on this host" and a **Clone onto host…** button that
    opens the dialog for the current host. That fixes `gary` as it stands
    today.

## Consequences

- Moving a project to a box now produces a working project, and the path the
  user gets is visible and editable in the dialog.
- The project record is updated in place. Existing local worktrees on the Mac
  are not moved: they drop out of the sidebar (workspaces come from
  `git worktree list` on the new host) but stay on disk. Their stale path keys
  stay in `workspaceNames` and similar fields, which does no harm.
- Moving a project back from a host to Local is not solved here. The guard
  makes it fail with a clear error rather than breaking silently, unless the
  remote path also exists locally. A "choose local folder" flow can follow if
  it's needed.
- Panes that are already open keep running on their original host (sessions
  are routed by `hostForSession`), as with today's host switch.
- The clone step runs through `execStream` on the host, so it depends on the
  box being able to reach `origin`. The health check that follows reports
  that, with fix-its.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
