---
type: adr
status: accepted
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

# ADR-213: One-click Copy to / Move to host for projects

## Context

A project can live on this machine or on a remote host (ADR-160, ADR-178). It
can move between them (ADR-179), and two clones of one repo on two hosts can
be linked into one sidebar entry (ADR-192). Doing any of this today is clunky:

- **Hard to find.** Moving is in Project Settings → Host → "Change host…".
  Copying ("Clone onto another host…") is only in the New Workspace dialog's
  host picker, and only for a project that is already linked
  (`hostsToCloneOnto` returns `[]` for an unlinked project).
- **Always a form.** `CloneToHostDialog` asks for a repo URL and a remote
  directory every time. The repo URL is pre-filled from `origin`. The
  directory is hard-coded to `~/code/<slug>`, so it ignores where the project
  lives now and any path the project already had on that host
  (`hostPaths`).
- **One way only.** Every clone-onto path is remote-only:
  - `moveProjectToHost` calls `ctx.hosts.assertRemote` (`host-move.ts:82`).
  - `projectsMoveToHost` calls `assertRemoteHost` (`bridge/handlers/projects.ts:136`).
  - `hostsToCloneOnto` filters to remote hosts.

  Going back to local works only if a local checkout already exists. If not,
  `switchProjectHost` throws "does not exist on this Mac" and the user has to
  pick a folder.

  `ProjectHostSection` also shows "Clone onto host…" when the current host is
  local, and that path throws "A remote host is required."
- **Copying takes two calls from the renderer.** `cloneIntoGroup`
  (`project-store.ts:1278`) runs `projects.clone` and then `projects.link`. If
  the link fails, an unlinked clone is left behind.

The parts are already there:

- `planClone` / `runClone` / `prepareRemoteClone` handle local targets and
  adopt a directory that is already a clone.
- `cloneProject` adds the clone as a project, or returns the project that
  already owns it.
- `linkProjects(newId, sourceId)` creates the group from the source's settings.
- `switchProjectHost` and `repointProject` re-point the same project record.

This ADR is slice 1 of the transfer work. Later slices are out of scope:
progress in the sidebar, keeping tabs open across a Move, copying files git
ignores and running setup, and bringing workspaces along.

## Decision

### Vocabulary

- **Copy to \<host\>**: clone (or adopt) the repo on the target host as a
  **new project linked to the source** (ADR-192). Both stay.
- **Move to \<host\>**: re-point the **same project record** at a checkout on
  the target host (ADR-179). Its id, settings, Linear links and per-path
  settings for the main workspace all carry over.
- A **transfer** is either one. Targets are "This machine" plus every
  registered remote host.

### Main: `electron/projects/host-transfer.ts` (new)

**`planTransfer(ctx, projectId, hostId)`** works out where the project goes
without changing anything. It returns one of two results:

```ts
type TransferPlan =
  | { kind: "ready"; repoUrl: string; targetDir: string; via: "remembered" | "adopt" | "mirror" | "default" }
  | { kind: "needsInput"; reason: TransferInputReason; repoUrl: string | null; targetDir: string };
```

It resolves the target directory in this order:

1. **`remembered`**: `project.hostPaths[hostId]`, when it exists on the host
   and is a clone of the same origin. Use `remoteDirIsCloneOf`, or for local
   compare `originKey`.
2. **`adopt`**: a project already on that host whose `originKey` matches and
   that is not in another group. Copy links it, and Move is refused; see
   below. Checking this means running `git remote get-url` once for each
   project on the host. Use `OriginLinks.keyOf`, which caches.
3. **`mirror`**: when the source path is under the source host's home, use
   the same path under the target's home
   (`/Users/me/Code/manor` → `~/Code/manor`). Use `ctx.paths.homeDir` and
   the target's `facts.join`.
4. **`default`**: `~/code/<toDirSlug(name)>`. Move `toDirSlug` to a shared
   `src/lib` module if it isn't already importable from `electron/`.

`needsInput` reasons:

- `no-origin`: no `origin` remote.
- `dir-taken`: the target directory is not empty and is not a clone of the
  same repo, or another project owns it (`planClone`'s owner check).
- `host-taken`: the group already has a member on that host
  (`assertGroupHostFree`).

`host-taken` is returned only from a direct call. The menu disables those
hosts first.

**`transferProject(ctx, projectId, hostId, mode, overrides?)`**. When
`overrides` has `{ repoUrl, targetDir }`, it skips `planTransfer` and only
the safety checks run (`planClone` owner, `assertGroupHostFree`):

```ts
type TransferResult =
  | { ok: true; project: ProjectInfo }
  | { ok: false; needsInput: Extract<TransferPlan, { kind: "needsInput" }> & { mode: "copy" | "move"; hostId: string } };
```

- **`copy`**:
  1. Run `planTransfer`.
  2. Run `cloneProject({ hostId, repoUrl, targetDir, name: source.name })`.
     The adopt and owner cases fall out of this.
  3. Run `linkProjects(newId, sourceId)`, so the group is created from the
     source's settings.

  Clone and link become one call in main. `cloneIntoGroup` in the store
  switches to it.
- **`move`**:
  - `remembered`: use `switchProjectHost(projectId, hostId, targetDir)`.
  - Otherwise: use `moveProjectToHost` with the planned `repoUrl` and
    `targetDir`.
  - An `adopt` plan gives `dir-taken` for a move. Two project records would
    then claim one checkout, and the user should link them instead.
- A clone failure throws, as it does today. The renderer shows it as a toast.

**Allow local targets in `moveProjectToHost`:**

- Replace `ctx.hosts.assertRemote(hostId)` with `assertKnown`.
- Keep the path rules: `resolveCloneDir` already has a local branch.

### Bridge

Add `projects.transfer({ projectId, hostId, mode })` to
`electron/bridge/handlers/projects.ts`.

- Call `ensureConnected` only for a remote host, the same as `projectsClone`.
- Clone progress keeps using `projects:clone-progress`.
- In `projectsMoveToHost`, drop `assertRemoteHost` and call `ensureConnected`
  only for remote hosts, so the dialog's fallback path also works to local.
- Add the method to the preload and to `src/electron.d.ts` types.

### Renderer

**`src/lib/transfer-targets.ts` (new)**:
`transferTargets(project, projects, hosts, mode)` →
`{ hostId, label, disabledReason }[]`, built from the same parts as
`hostsToCloneOnto`. It works for unlinked projects too.

- It lists "This machine" plus every remote host, minus the project's current
  host.
- **Disabled hosts:**
  - The host's last connect failed (`error`). Use the same reason text as
    today.
  - Copy: the group already has a member on that host ("Already on
    \<host\>").
  - Move: another member of the group already lives on that host.

**Store: `transferProject(projectId, hostId, mode)` in `project-store.ts`:**

1. Shows a persistent `loading` toast: "Copying manor to wsl-box…". The
   toast detail shows the last line of clone progress.
2. Calls the bridge.
3. On `ok`:
   - Changes the toast to `success`: "manor is on wsl-box".
   - Refreshes projects.
   - Runs `hosts.healthCheck` in the background for remote targets. A failed
     check adds a toast action that opens Project Settings.
4. On `needsInput`: dismisses the toast and sets
   `transferDialog: { projectId, hostId, mode, reason, repoUrl, targetDir }`.
   The fallback dialog opens from that state.
5. On a throw: shows an `error` toast with the message and a "Customize…"
   action that opens the same dialog.

**Sidebar menu:** add `ProjectTransferMenu` in
`src/components/sidebar/ProjectTransferMenu.tsx`. It renders Radix
`ContextMenu.Sub` items in the same style as the existing "Link with…"
submenu.

| Where | Items |
| --- | --- |
| Lone project (`ProjectItem`, `!isSection`) | **Copy to ▸**, **Move to ▸** |
| Linked group header (`ProjectGroupItem`) | **Copy to ▸**. The source is the local member if there is one, otherwise the first member. |
| Host section header inside a group (`ProjectItem`, `isSection`) | **Move to ▸**, for hosts where the group has no member |

- **Each submenu:** one item per target, "This machine" first. Disabled
  targets show their reason in a `Tooltip`.
- **Last item:** "Choose location…", which opens the dialog with the planned
  values.
- **Move confirmation:** before a Move, show a `ConfirmDialog` when any
  workspace has open panes, or when the project has worktrees besides main:
  - "Moving closes this project's tabs."
  - "N workspaces stay on \<old host\> and won't show in Manor until you move
    back."

  Move `projectHasOpenPanes` from `ProjectHostSection.tsx` to
  `src/lib/project-panes.ts` so both places can use it.

**Fallback dialog:** extend `CloneToHostDialog`:

- New `mode: "copy"`. Both modes submit through
  `transferProject(projectId, hostId, mode, { repoUrl, targetDir })`.
  `transferProject` in main and `projects.transfer` take optional `repoUrl`
  and `targetDir` overrides that skip planning. The dialog and the one-click
  path then share one operation, and `cloneIntoGroup` becomes a thin wrapper.
- Accept `initialHostId`, `initialRepoUrl`, `initialDir` and a `reason`
  banner ("That folder already has something else in it — pick another.").
- Allow "This machine" as a host choice. Hide the health-check step for local,
  as `AddProjectDialog` does with `skipHealthChecks`.

Mount it once in the sidebar, driven by `transferDialog` state.

`ProjectHostSection` keeps its picker. Its remote choice and its "Clone onto
host…" button now call `transferProject(…, "move")`, which also fixes the
local-host bug above.

### Out of scope

- Progress in the sidebar row (slice 2).
- Keeping tabs open across a Move (slice 2).
- Copying `.env` files and running setup (slice 3).
- Bringing workspaces and agent sessions along (slice 4).
- Drag and drop.
- A CLI command.
- A setting for the default clone directory. Mirroring covers the common case.

## Consequences

**What gets better:**

- Copy or Move is two clicks from the sidebar, with no form when nothing is
  ambiguous. Local and remote work the same in both directions.
- Copy is one call in main, so a failed link can't leave an unlinked clone.
- Mirroring the home-relative path keeps checkouts in the same place on every
  machine, which also helps later slices that match workspaces across hosts.

**Costs and risks:**

- `planTransfer` runs git on each project on the target host to find an
  origin to adopt. `OriginLinks.keyOf` caches this, but a cold first plan on a
  slow host costs one ssh round-trip per project there. If that's too slow, it
  can be dropped to the `remembered` and `mirror` checks only.
- **Move still leaves worktrees behind,** and they don't show in Manor until
  the project moves back. The confirmation says so. Slice 4 fixes it.
- **Move still closes tabs** (slice 2).
- **Allowing local in `moveProjectToHost` adds a new path:** cloning into a
  local folder from the move flow. `resolveCloneDir`'s local branch and
  `prepareRemoteClone`'s "refuse a non-empty unrelated directory" check
  already guard it, but it needs tests.
- **Three ways in:** the sidebar menu, Project Settings and the New Workspace
  host picker. They now share one main operation, and only the entry points
  differ.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
