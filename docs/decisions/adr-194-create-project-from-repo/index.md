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

# ADR-194: Create a project by cloning a repo

## Context

"Add Project" (`src/components/sidebar/AddProjectDialog/AddProjectDialog.tsx`)
offers two paths:

- **On this Mac**: pick an existing folder (`dialog:openDirectory` →
  `projects:add` → `ProjectSetupWizard`).
- **On a remote host**: type a repo URL + remote directory; Manor clones it
  there (`projects:addRemote` → `ProjectManager.addRemoteProject` →
  `planRemoteClone`/`runRemoteClone` in `electron/projects/host-move.ts`),
  streams progress on `projects:clone-progress`, then runs host health checks.

There is no way to start a project from a repo you don't have checked out
locally: you clone in a terminal, then come back and pick the folder. And
every clone path requires typing the URL by hand, even though Manor already
uses `gh` (`electron/github.ts`) and knows which repos you have access to.

Nothing in the clone pipeline is actually remote-specific. `GitBackend.cloneStream`
(`electron/backend/exec-git.ts`) is implemented by the shared exec-git backend
that the local backend (`createLocalBackend`) uses too; `resolveRemoteDir`
expands `~` against `ctx.paths.homeDir(hostId)`, which works for the local
host; `remoteDirState`/`remoteDirIsCloneOf` go through `ProjectHost`. Only
`hosts.assertRemote` gates it to remote hosts.

## Decision

### 1. One clone path for every host

- `ProjectManager.addRemoteProject` becomes `cloneProject(opts: { hostId,
  repoUrl, targetDir, name })` and uses `hosts.assertKnown` instead of
  `assertRemote`. Same adopt-if-already-a-clone / refuse-non-empty /
  return-existing-owner semantics as today.
- `planRemoteClone` → `planClone`, `runRemoteClone` → `runClone`
  (`host-move.ts`); `moveProjectToHost` keeps its own `assertRemote`.
- Directory validation: remote hosts keep `validateRemoteDir` (strict
  allowlist). For `LOCAL_HOST_ID`, a folder picked from the OS dialog may
  contain spaces, so accept any absolute or `~/` path that does not start with
  `-` and is not `/`. `remoteDirState` already `shellQuote`s, and `git clone`
  gets the path after `--` as its own argv entry, so no shell ever sees it
  unquoted. Put this in `resolveCloneDir(hostId, …)` in `remote-clone.ts`.
- IPC: `projects:addRemote` → `projects:clone` (`electron/ipc/projects.ts`,
  `electron/preload.ts`, renderer type). `ensureConnected` only for remote
  hosts. Store action `addRemoteProject` → `cloneProject`.

### 2. List GitHub repos via `gh`

New `GitHubManager.listRepos()` in `electron/github.ts`: `gh api
"user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member"
--paginate` (local `gh`, like every other `gh` call), mapped to
`{ nameWithOwner, description, private, sshUrl, httpsUrl, pushedAt }`. Which
URL to clone follows `gh config get git_protocol` (`ssh` → `sshUrl`, else
`httpsUrl`), returned as `cloneUrl`. Cached in memory for 5 minutes. When `gh`
is missing or not authed it returns `[]` with no error — the URL field still
works. IPC `github:listRepos`.

### 3. Add Project dialog

```
Add Project
  [ Open folder | Clone repository ]

  Clone repository:
    Host        [ This Mac ▾ ]               ← local + remote hosts, default This Mac
    Repository  [ search your GitHub repos… ▾ ]   (SearchableSelect)
                or paste a URL [ git@github.com:org/repo.git ]
    Location    [ ~/code/repo ] [Browse…]     ← Browse only for This Mac
    Name        [ repo ]
                              [Cancel] [Clone]
```

- Top toggle is now *what* you're doing (open vs clone); the host picker lives
  inside the clone form. "Open folder" keeps today's local folder flow; the
  current remote "add existing path" flow didn't exist before and is not added.
- Picking a GitHub repo fills the URL field and name. Typing a URL clears the
  picked repo.
- Location defaults to `<parent>/<repo name>` where `<parent>` is the parent
  directory of the most recently added project on that host, else `~/code`.
  It follows the repo name until edited. Browse… opens `dialog:openDirectory`
  and sets `<picked>/<repo name>`.
- After a **local** clone: close the dialog, select the project and open
  `ProjectSetupWizard` (same as "Open folder"). After a **remote** clone: keep
  today's health-check step.
- Also add "Clone Repository…" to the command palette (`useCommands.tsx`),
  opening the dialog on the clone tab.

## Consequences

- Better: one-step new project from any repo on any host; no hand-typed URLs
  for GitHub repos.
- `CloneToHostDialog` (move) is untouched apart from the renamed helpers.
- The local directory rule is looser than the remote one; safe because paths
  never pass through an unquoted shell, but it's a second rule to keep in mind.
- `gh api --paginate` over many orgs can take a few seconds; the picker shows a
  loading state and the URL field works meanwhile.
- Non-GitHub repos (GitLab etc.) work only via pasted URL.
- IPC/store rename touches the e2e fixture (`tests/e2e/fixtures.ts`) and any
  tests referencing `addRemote`.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
