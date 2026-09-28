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

# ADR-191: Host-qualified workspace identity

Layer 1 of #237 (local and remote workspaces side by side). Tickets map to
GitHub issues #238–#243. Layer 2 (linked projects) gets its own ADR.

## Context

Manor identifies a workspace by its bare absolute path. Since ADR-160 a
project can live on a remote host, and ADR-178 made that "one box per
project". A workspace has no host of its own (`WorkspaceInfo`,
`electron/projects/types.ts`). Its host is inferred, either from the project
it belongs to or from its path.

Paths are not unique across hosts. The default worktree root is
`~/.manor/worktrees/<slug>` on this machine (`electron/paths.ts`) and
`<home>/.manor/worktrees/<slug>` on a remote host
(`electron/backend/machine-facts.ts`). The clone dialog defaults to
`~/code/<slug>`. A Linux or WSL laptop that reaches a Linux box as the same
user gets **byte-identical paths** on both. That is the common case for
anyone who keeps a local and a remote project of the same repo, which is also
the only way to work on one repo in both places today.

When two hosts have the same path:

- **A new terminal can open on the wrong machine.** `pty:create` carries only
  a cwd (`electron/ipc/pty.ts`). `RoutedBackend.createOrAttach` routes a new
  session to `sessions.ownerOf(id) ?? hostForPath(cwd)`
  (`electron/backend/routed-backend.ts`). `PathRouter.hostIdForPath` picks the
  closest project root and **local wins ties**
  (`electron/projects/path-router.ts`). A fresh pane in the remote workspace
  runs its shell on the laptop.
- **Layouts overwrite each other.** The renderer's `workspaceLayouts`
  (`src/store/app-store.ts`) and the daemon's `layout.json`
  (`electron/terminal-host/layout-persistence.ts`, version 2) are keyed by
  bare `workspacePath`, across all projects.
- **`/context` can pick the wrong project.** `matchProjectByPath`
  (`electron/pane-context.ts`) returns the first project whose workspace path
  matches. ADR-189 made `/context` host-aware for *relayed* requests: when
  `ControlDeps.callerHostId` is set, `routes/context.ts` keeps only that
  host's projects as candidates on every rung. A local caller has no
  `callerHostId`, so it still sees every project and can be handed a remote
  one. Rung 1 (by pane id) also reads a path-only `workspacePath` from
  `layout.json` and then matches it by path, so it has the same ambiguity.
  ADR-189 says resolving by pane id "is unchanged, since pane ids are unique
  across hosts". The pane id is unique, but the workspace it leads to is a
  bare path, so that rung is still path-ambiguous. This ADR corrects that
  claim; see §4.
- **The GitHub repo cache is shared.** `GitHubManager.remoteRepoCache`
  (`electron/github.ts`) is keyed by `repoPath`, and the "use `gh -R`" choice
  comes from `hostIdForPath(repoPath)` (`electron/app-lifecycle.ts`).
- **Agent connectivity follows the project, not the terminal.**
  `isAgentHostConnected` (`electron/ipc/agents.ts`) looks up the host of the
  agent's `projectId`. Saved agents (`electron/agent-persistence.ts`) store
  `projectId`, `workspacePath` and `cwd`, with no host. An agent in a pane that
  ADR-183 moved to another host reports the wrong host.
- **Portless hostnames collide.** A main checkout is `project.localhost`
  (`electron/portless.ts`), so a local main and a remote main of the same repo
  both claim it, and the last route wins.

### Correction to ADR-160

ADR-160 §6 says "Panes resolve their backend through their project". The code
has never done that. An existing pane routes by its session owner
(`SessionOwners`, `electron/backend/session-owners.ts`): the first host to
claim a pane id owns it. A **new** pane routes by the host its cwd belongs to
(`hostForPath(cwd)`). Only prewarm and the pollers pass a host explicitly
(ADR-183). This ADR replaces ADR-160's sentence with: *a pane resolves its
backend through its session owner, and a new pane through the host of the
workspace it was created for. The cwd is only a fallback.*

## Decision

A workspace is identified by **(host, path)** everywhere Manor keys or
routes by workspace. This is the expand/contract pattern: ticket 1 adds the
key and its helpers alongside the path key, and tickets 2–6 switch each
consumer over, one per issue.

### 1. The workspace key (`src/lib/workspace-key.ts`)

A deterministic string, not a minted id. `git worktree list` gives Manor
paths, not ids, so a string built from host and path needs no lookup table,
and migrating to it is mechanical.

- Local: the bare path, `/home/me/app`.
- Remote: `<hostId>:<path>`, `3f1c…:/home/me/app`.

Local keys stay bare so that local-only files are unchanged, as story 10 of
#237 asks, and so the local stores that already hold path keys are already in
the new shape. Host ids are `"local"` or UUIDs (`electron/ipc/hosts.ts`), so
the first `:` always ends the host id. A remote key's path must be absolute.
Anything else parses as a bare local path, and a single-letter host part is
never read as a host, so neither `C:\…` nor `C:/…` is read as host `C`.

The module is pure. It imports only `src/lib/host-id.ts`, a new DOM-free
module holding `LOCAL_HOST_ID` and `normalizeHostId`, so it compiles for the
renderer (`tsconfig.json`) and main (`tsconfig.electron.json`). `src/lib/` is
where code shared by both processes already lives (`pr-info.ts`,
`keybinding-defs.ts` and `menu-commands.ts` are imported from `electron/`).
`src/lib/hosts.ts` re-exports `LOCAL_HOST_ID` from `host-id.ts`; it can't be
imported by main itself because it reaches for `window`. Main's own
`LOCAL_HOST_ID` in `electron/backend/types.ts` stays, and a test pins the two
together. `PathRouter.hostIdForPath` delegates its closest-root search to
`ownerHostIdForPath`, so the tie-break rule and `isWithinPath` exist once.

API:

- `workspaceKey(hostId, path): WorkspaceKey`. A missing host means local. For
  a remote host it throws when the key could not be parsed back: a host id
  that contains `:`, `/` or `\` or is a lone letter, or a path that is not
  POSIX-absolute (relative, `C:\a`, `C:/a`).
- `parseWorkspaceKey(key): { hostId, path }`.
- `isRemoteWorkspaceKey(key)`.
- `ownerHostIdForPath(owners, path)`: the host of the project whose root,
  expanded worktree root or known workspace contains `path` most closely.
  Local on a tie and when nothing matches, the same rule as
  `PathRouter.hostIdForPath`. `ProjectInfo` from either process is a valid
  owner as is.
- `migrateWorkspaceKey(key, owners)`: leaves a qualified key alone, and
  assigns a bare path to `ownerHostIdForPath`.
- `migrateWorkspaceKeyedRecord(record, owners)`: rekeys a map. If a legacy
  entry and an already-qualified entry name the same workspace, the qualified
  one wins.

`WorkspaceKey` is a branded string, so a bare path can't be passed where a
key is expected without going through a helper.

**Migration runs once per store, behind that store's own version marker.**
After migration, a bare key means local. Migrating it again could move it to
a remote project that has the same path and no local twin. The daemon's
`layout.json` goes from version 2 to 3. Agent records gain a `hostId` field,
and a record without one is the legacy shape.

Legacy data can be ambiguous: a bare path that both a local and a remote
project own. It migrates to local, the same answer the code gives today, so
migration never changes behavior for that entry. From then on, the other
host's copy is written under its own key.

**Rejected: qualifying local keys too** (`local:/p`). Every key would then say
its host, so a bare key would always be legacy, and migration would be safe
to re-run with no version marker. But every local-only user's `layout.json`,
agent records and other path-keyed files would be rewritten on upgrade, which
story 10 of #237 rules out, and a downgrade would find none of its keys. A
version marker per store is a smaller cost than rewriting every local file.

### 2. Terminals are created on the host they were asked for (#239)

`pty:create` gains an optional `hostId`. `RoutedBackend.createOrAttach`
routes by `sessions.ownerOf(id) ?? hostId ?? hostForPath(cwd)`. The renderer
passes the host of the workspace the pane is created for: new tab, split,
restore and prewarm. Prewarm already passes one (ADR-183). `hostForPath`
stays as the fallback for callers that truly don't know the host. A pane moved
by ADR-183 keeps reporting its session owner.

### 3. Layouts keyed by workspace key (#240)

The daemon's `PersistedLayout` workspaces are keyed by `workspaceKey`, with a
`version: 3` bump and a load-time migration from version 2 that uses the
projects in `projects.json` as owners. The renderer's `workspaceLayouts` is
keyed the same way. Navigation history (`src/store/navigation-history-store.ts`)
keys its workspace entries by `workspacePath` too, and moves to the key.

**There is a single migration site, in main.** This departs from #237, which
says the migration runs "in the main process and in the renderer store". The
renderer has no persisted copy of its own to migrate: `workspaceLayouts` is
filled from `layout.json` through `layout.load()` (`src/store/app-store.ts`),
and navigation history lives in memory only. Migrating in main, where
`projects.json` and the expanded worktree roots are at hand, means the
renderer only ever sees qualified keys, and there is one version marker, not
two that could disagree.

### 4. `/context` matches by host plus path (#241)

Every caller has a host. For a relayed request it is ADR-189's
`callerHostId`. For a local caller it is local, unless the caller's pane is
owned by a remote host. `matchProjectByPath` narrows by host before matching
the path, and rung 1 reads a workspace key from `layout.json`, not a bare
path. That fixes the ambiguity ADR-189 said rung 1 didn't have. This builds
on ADR-189 and generalizes it. ADR-189's filter means
"projects on that host". Here it means "workspaces on that host", which is
what #237 layer 2 needs once a linked group has one member per host. A local
caller also gets its host scoped, which ADR-189 left open.

### 5. Agents follow their pane's host (#242)

`isAgentHostConnected` asks `SessionOwners` for the host that owns the
agent's pane, and uses the project's host only when the pane has no owner.
Saved agents record `hostId`. A record without one takes its project's host
on load.

### 6. GitHub cache and portless hostnames by host (#243)

`remoteRepoCache` is keyed by the workspace key. The "use `gh -R`" decision
takes the caller's host when it is known. Portless hostnames for non-local
hosts gain a host segment derived from the **host id**, not the host's name:
the first 8 characters of the id, lowercased, with the full sanitized id used
if two hosts share that prefix (for example `project.3f1c2a9e.localhost` and
`branch.project.3f1c2a9e.localhost`). A name (the ssh target) can be edited,
which would silently move every URL the user has bookmarked, and two hosts can
share a name, which is the very collision this fixes. The id is stable and
unique. Local hostnames are unchanged.

### Out of scope

The per-project path maps (`workspaceNames`, `workspaceOrder`,
`workspaceIssues`, `workspaceHidden`, `workspaceFolderIds`) and
`sidebarOrder` stay keyed by bare path. A project lives on exactly one host
(ADR-178), so inside a project the path is already unique. Linked projects
(layer 2) keep that true, because each member is still a single-host project.

## Consequences

- **Fixes a live bug with no UI change.** A local and a remote project of the
  same repo at the same paths no longer share a terminal host, a layout, a
  `/context` answer, a repo-cache entry or a hostname.
- **Local-only users see no change.** Local keys are bare paths, so every
  migration is the identity when no remote host is registered, and files are
  written back byte-for-byte, as `StateStore` already does for `hostId`.
- **A bare key is overloaded.** It means "local" in new data and "unknown
  host" in legacy data. Every store must gate its migration on a version, or
  an entry could move hosts on a second run. The helper's doc comment says
  so, and each ticket bumps a version.
- **Ambiguous legacy entries go to local.** A layout saved before this change
  for a path both hosts have is kept by the local workspace. The remote
  workspace starts with a fresh layout once. This is the least surprising
  answer, because it is what the user saw before the upgrade.
- **Keys are tied to paths.** Re-pathing a workspace changes its key. That is
  already true of every path-keyed store, and `repointProject`'s rekeying
  (`electron/projects/host-move.ts`) must now rekey by workspace key when a
  project moves hosts.
- **Two consumers still infer the host from a path.** `hostForPath` remains
  for callers without a host, and `remoteHostIdForWorkspace`
  (`src/lib/hosts.ts`) takes the first matching project rather than the
  local one on a tie. Both are safe once their callers pass a key or a host,
  and the tickets below move the known callers.
- **Layer 2 is unblocked.** Linked projects can put workspaces of
  one repo on two hosts in one sidebar entry, and nothing downstream confuses
  them. A later move to one project owning several checkouts (design A in
  `docs/research/mixed-local-remote-workspaces.md`) needs no second identity
  migration.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
