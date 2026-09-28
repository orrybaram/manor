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

# ADR-192: Linked projects

Amends ADR-178 ("one box per project"). It does not reverse it. Layer 2 of
spec #237; layer 1 (host-qualified workspace identity) is ADR-191.

## Context

Users work on the same repo in two places: on the laptop and on a remote build
box that Manor reaches over ssh (ADR-160, ADR-178). ADR-178 ties each project
to one host: `PersistedProject.hostId` (`electron/projects/types.ts`), with
"one box per workspace" out of scope. So the only way to have workspaces on
both machines today is to add the repo twice, as two unrelated projects. That
gives:

- **Two sidebar entries for one repo.** Each has its own color, agent command,
  commands and Linear association, and they drift apart.
- **No "where should this run?"** The New Workspace dialog
  (`src/components/sidebar/NewWorkspaceDialog/`) sends only a project id. The
  user must first remember which of the two projects is the box.
- **No tie between them** for the CLI, suggestions, or host status.

The research note `docs/research/mixed-local-remote-workspaces.md` compared
three designs:

- **A. One project owns several checkouts.** This means a per-host checkout map
  and a host on every workspace. It is the "true" model, but it touches almost
  every file that assumes one host per project (worktree create, remove,
  merge, branch lists, pollers, portless, settings, CLI). It also reverses
  ADR-178.
- **B. Linked projects.** A group record sits over ordinary single-host
  projects.
- **C. A standalone clone per workspace.** Rejected, because workspaces stop
  being `git worktree list` output.

Git also forces one checkout per host. Linked worktrees share one `$GIT_DIR` on
one filesystem, so a remote workspace can't be a worktree of a local clone. B
takes that as given: each member is a clone on its own host.

The workspace-identity collision (the same path on two hosts) is a separate,
live bug that exists across two projects today. ADR-191 fixes it
independently, and this ADR does not depend on that fix being merged.

## Decision

Ship design B. **A project group** links single-host projects of the same repo
and presents them as one sidebar entry. Every member stays an ordinary project
on exactly one host. So ADR-178's invariant ("a project lives on one box")
still holds, and worktree create, remove, quick merge, convert-main, branch
listing, default-branch detection and all pollers are unchanged. ADR-178 is
amended only in what the *user* sees: one repo can now span hosts, as a group.

### 1. Data model (`electron/projects/`)

`PersistedState` gains an optional `groups?: PersistedProjectGroup[]`:

```ts
interface PersistedProjectGroup {
  id: string;                 // crypto.randomUUID()
  name: string;               // display name; defaults to the first member's name
  memberIds: string[];        // project ids, in section order
  lastUsedHostId: string | null;
}
```

Invariants, enforced in `electron/projects/project-groups.ts`:

- A project belongs to **at most one** group.
- A group holds **at most one project per host**, so "where does this run" has
  one answer.
- A group has **at least two** members. Unlinking the second-to-last member
  dissolves the group.

`StateStore.load` normalizes groups read from disk. It drops unknown or
duplicate members, extra members on a host that is already taken, and groups
left with fewer than two members. It also clears a `lastUsedHostId` that no
member is on. An absent or empty list is not written back,
so files without groups stay byte-identical (the same approach as `hostId`
and `"local"`).

Later tickets add to the record: shared settings (color, agent command, Linear
association, ticket 2) and the normalized `origin` URL (ticket 5). Both are
optional fields, so they need no migration.

### 2. ProjectManager API

- `linkProjects(projectId, otherProjectId): ProjectGroupInfo`. If either
  project is already grouped, the other joins that group; otherwise a new group
  is created with `other` first, named after it, and with its host as last
  used. Refused (throws) when the ids are the same or unknown, when both are
  in different groups, or when the group already has a member on the joining
  project's host. Linking two projects already in the same group is a no-op.
- `unlinkGroup(groupId)`. Dissolves a whole group in one write. Every member
  is left exactly as it was, except that (since ticket 2) it keeps the
  group's shared settings as its own.
- `unlinkProject(projectId)`. Removes the project from its group and dissolves
  a group left with one member. It never touches either project's workspaces,
  folders, order or per-host settings; since ticket 2 the leaving project, and
  the last member of a dissolved group, keep the group's shared settings. An
  ungrouped project is a no-op.
- `removeProject` also drops the project from its group.
- `switchProjectHost` and `moveProjectToHost` refuse a move onto a host where
  another member of the project's group already lives, so the one-per-host
  rule can't be broken from project settings.

### 3. What the renderer sees

`ProjectInfo` gains `group?: ProjectGroupInfo | null`, where
`ProjectGroupInfo = { id, name, memberIds, lastUsedHostId }`. `buildProjectInfo`
always sets it, to the summary or null. It is optional in the type only so
existing fixtures and the renderer's mirror type don't have to name it. Every
member carries the same summary, so the sidebar can build groups from
`projects:getAll` alone, with no extra round trip. IPC `projects:link`,
`projects:unlink` and `projects:unlinkGroup` (which dissolves a whole group,
for "Unlink All") are wired through `electron/ipc/projects.ts`,
`electron/preload.ts` and `src/electron.d.ts`. The renderer store gets
`linkProjects` and `unlinkProject` actions, which reload the project list.

### 4. Sidebar model (`src/utils/sidebar-items.ts`)

The pure builders gain a top-level layer above the per-project item tree:

```ts
type TopLevelEntry =
  | { kind: "project"; key: string; project: ProjectInfo }
  | { kind: "group"; key: string; group: ProjectGroupInfo; sections: GroupSection[] };
type GroupSection = { hostId: string; project: ProjectInfo; items: SidebarItem[] };
```

- `buildTopLevelEntries(projects)` walks the project list in order. A
  section's host is its member's `project.hostId`. A group
  takes the slot of its first member to appear, and its sections follow
  `memberIds`. Each section's `items` come from `buildSidebarItems(member)`,
  so a member's workspace order and folders are exactly what they were before
  linking. A group with fewer than two members in the list renders its member
  as a plain project, which is defensive only.
- In the renderer, the top-level order is a list of entry keys, with the
  **group id in place of its members**. `expandTopLevelOrder(keys, entries)`
  turns it back into the project-id order `projects:reorder` persists, with a
  group's members kept together in section order.
- **The group's position is derived, not stored.** Main keeps persisting only
  the project array order. A group sits wherever its first member sits, and
  nothing on disk holds a group id in an order. This departs from the spec's
  wording ("the top-level sidebar order stores the group id in place of its
  members"). The renderer's key list does that, but disk does not. The reason:
  a stored group-level order would be a second ordering beside the project
  array, and the two could drift apart. For example, the CLI, a project
  removal, or an older build could reorder projects without updating it.
  Deriving the position from members leaves one source of truth. The
  round trip `buildTopLevelEntries(expandTopLevelOrder(keys))` returns `keys`
  (tested).
- A group collapses and expands like a project: its id goes in the same
  `collapsedProjectIds` set, and member sections collapse on their own ids.

`Sidebar.tsx` renders entries instead of raw projects, and project drag
reorders entries. A new `ProjectGroupItem` renders the group header and one
`ProjectItem` per section in a new `variant="section"`. That variant swaps the
project header for a host label (the `HostIndicator` chip for a remote host,
"This machine" for local) and keeps the member's full context menu, workspace
list, folders and dialogs. The header's shared behavior (keyboard handling,
refocusing after a keyboard-opened menu, the chevron and the project color)
lives in `useProjectHeaderRow` and `ProjectChevron`, so the project and group
headers can't drift apart. The project context menu gains **"Link with…"** and
**"Unlink"**. "Link with…" is a submenu with one row per eligible lone project
and one row per eligible group (`linkChoices`). The group header's menu has
**"Unlink All"**. Navigating into a member (selecting it, or jumping to one of
its agents) expands its group as well as the member. A dissolved group's
collapsed key is cleared.

The rules for which hosts a group occupies, and the "already has a project on
<host>" message, live in the DOM-free `src/lib/project-groups.ts`. Main
enforces them with it, and the sidebar filters with it, so both apply the same
rule.

### 5. Later tickets (layer 2)

- **Shared settings on the group (ticket 2).** Group-first resolution of name,
  color, agent command and Linear association. Unlinking copies the group's
  shared values onto the project that leaves. Group and per-host sections in
  project settings.
- **New Workspace host picker (ticket 3).** It chooses which member project to
  create in and defaults to `lastUsedHostId`, which it records. Offline hosts
  are disabled with a tooltip. Unlinked projects are unchanged. Opened from
  one host's own section, it starts on that host instead (see the ticket).
- **"Clone onto another host…" (ticket 4)** from the picker. It reuses the
  existing clone flow and links the result.
- **Link suggestions by `origin` (ticket 5).** Normalized with the existing
  GitHub remote parsing, stored on the group, and suggested for the user to
  confirm. Manor never links on its own. The logic lives in
  `electron/projects/origin-links.ts`. `originKey` is `normalizeOriginUrl`
  plus a guard: a remote that is only a path on disk (absolute, relative, a
  Windows drive or `file://`) is never matched, because it names a different
  directory on each host. The group stores it as `originKey`. A member
  leaving clears it, and it is derived again from the members that remain.
  A group is offered once, under its first member. Dismissed pairs of project
  ids are persisted as `dismissedLinkSuggestions`. The key is absent until
  the first dismissal and is dropped with the last one, so files of users who
  never dismiss stay unchanged. A dismissal with any member of a group
  covers the whole group. The renderer offers each suggestion as a
  persistent, neutral `info` toast, one per pair. It does this after
  `addProject` and `addRemoteProject`, and once per launch for ungrouped
  projects after they load, so duplicates added before linking existed are
  found too. A remote host is usually still connecting at that point, so
  when a host first connects in a session its ungrouped projects are asked
  again. A pair is offered at most once per session. A successful link
  closes the other open suggestions that name either project.
- **Host status for groups (ticket 6).** Connected / offline / partially
  offline, derived from members. The offline section dims. The status bar chip
  and the tab badge follow the workspace's host, and the collapsed-group agent
  dot counts every section.
- **Multi-select across sections (ticket 7)**, once ADR-190 lands.
- **CLI (ticket 8).** Listings include groups, and create-workspace takes
  `--host`.

## Consequences

**Better**

- One repo takes one sidebar slot, and each host's workspaces sit under a
  labeled section. This is the base the host picker, shared settings and
  suggestions build on.
- The change is additive. Existing `projects.json` files load unchanged, and a
  file with no groups is written back byte-identical. Nothing is rekeyed.
- Worktree, branch, poller, portless and routing code are untouched, because
  every member is still a single-host project. Unlinking is a pure record
  change, so it's safe to try.

**Harder / risks**

- "Project" now means two things: the member (data, settings per host) and the
  group (what the user sees). Until ticket 2, settings still drift between
  members.
- Workspaces can't interleave across hosts: each section has its own order and
  folders. Mixing them would need a group-level order (design A territory).
- Selection is still per member project (`selectedProjectIndex`). The group
  header has no selection of its own, so the selected member's section shows
  the accent border.
- `hostIdForPath` still breaks ties toward local when two members share a path.
  Linking makes such pairs more likely. ADR-191 (layer 1) is the fix; this ADR
  neither causes nor fixes it.
- Moving a group's member to a host another member already has is refused
  rather than merged.
- Going to design A later means folding the group record into a per-host
  checkout map. Once layer 1 has made identity host-qualified, that is mostly
  mechanical.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
