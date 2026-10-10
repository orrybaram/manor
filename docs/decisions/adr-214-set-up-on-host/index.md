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

# ADR-214: One verb for where a project lives: "Set up on"

Amends ADR-213 (one-click transfer) and ADR-192/193 (linked projects). It
keeps their main-process mechanics and replaces the concepts users see.

## Context

After ADR-213 the sidebar has three actions that mostly do the same thing:

- **Copy to ▸ host**: clone onto the host, then link to the source
  (lone project and group header).
- **Move to ▸ host**: re-point the same project record. A confirm warns
  that tabs close and other workspaces stay behind (lone project and group
  host section).
- **Link with…**: join two existing projects of the same repo. "Choose
  local folder…" adds and links a local checkout. Lone project, group
  header, the Project Settings "Link with" select, and link-suggestion
  toasts all offer it.

Getting rid of a copy on one host takes yet more terms. "Unlink" and
"Unlink all" are in menus and settings. A group host section has no Remove
item at all, though the command palette's `remove-project` removes just
that member. Project Settings → Host → "Change host…" is a fourth path, a
Move again.

These are three ways to say "this repo is also on that machine", and each
makes different promises about what happens to tabs, workspaces and
settings.

Other tools (research, 2026-10-09):

- **Superset**, the closest match:
  - A project belongs to no machine.
  - You *set it up* on a host (`projects setup <id> --host`).
  - Every workspace is created on exactly one host.
  - It has no move.
- **Orca, VS Code Remote-SSH, Zed and JetBrains Gateway** tie a project to
  one host. None has a move. Orca's open issue #24352 asks for one.
- **Conductor, Codex cloud and Cursor** carry work across with git
  (branches, apply locally, PRs).
- No tool ships a real move between hosts.

Manor's data model already fits Superset's: a linked group is "one repo,
set up on N hosts" (ADR-192). Only the UI shows the seams: groups, links,
members, moves.

## Decision

### The model users see

A **project** is a repo. It is **set up on** one or more hosts, with at
most one checkout per host. In the code, a lone project is a group of one.
The UI never says "group", "member", "link" or "unlink".

| Action | Where | Does |
| --- | --- | --- |
| **Set up on ▸ \<host\>** | Lone project menu, group header menu, Project Settings, New Workspace host picker | ADR-213's `transferProject(…, "copy")`: clone or adopt on the host, then join. It asks for input only when needed (no origin, folder taken). |
| **Remove from \<host\>** | Group host-section menu, the host list in Project Settings | `removeProject(memberId)`, which already leaves the group, copies the shared settings onto the leaver, and dissolves a group of fewer than two. Files on the host are not deleted. |
| **Remove Project** | Lone project, group header | Unchanged: removes the project from Manor on every host. |

- **Move goes away as a concept.** A move is now "set up on the new host,
  then remove from the old one". The success toast for a set up offers that
  second step as its action, so a move is still two clicks:
  "manor is set up on wsl-box". [Remove from this machine]
- **Link goes away as a menu concept.** Same-origin projects join on
  their own (below). "Choose local folder…" becomes the dialog's "Use an
  existing folder…" (below).

### Auto-join same-origin projects

The link suggestions (`electron/projects/origin-links.ts` `suggest`,
`src/store/link-suggestions.ts` toasts) become automatic joins.

- **When:** at the same trigger points as today's suggestions:
  1. the first `loadProjects`;
  2. a host's first connect in the session;
  3. after `addProject` / `cloneProject`.
- **What:**
  - For each suggestion `suggest` returns, call `linkProjects(newcomer,
    existing)`, so the project that was there first keeps its settings.
  - `suggest` already rules out group-to-group pairs, hosts the group
    already covers, and dismissed pairs, so it can't break group
    invariants.
  - Main makes the joins in one new call, `projects.autoJoin()`, which
    returns the pairs it joined.
- **Undo:**
  - The renderer shows one toast per batch: "Joined manor on wsl-box with
    manor on this machine". [Undo]
  - Undo calls `unlinkProject` on the newcomer, then `dismissLinkSuggestion`
    for the pair. The dismissal is persisted, so the pair is never joined
    again.
  - A batch of three or more collapses into a summary toast. Its Undo
    reverts the whole batch.
- **Splitting later:** Project Settings has **"Keep separate…"** for a
  project set up on more than one host. It runs today's `unlinkGroup` and
  dismisses every pair it splits, so they stay apart. This is the only
  place "unlinking" survives.

### Carry the main workspace's metadata on set up

`transferProject` copy (`electron/projects/host-transfer.ts`) also copies
the source main workspace's `workspaceNames` and `workspaceIssues` entries
(keyed by `project.path`) onto the new project's path. Folder ids are not
copied: folders belong to each project.

### Surfaces

- **Sidebar** (`ProjectItem.tsx`, `ProjectGroupItem.tsx`):
  - **Lone project:** "Set up on ▸", "Remove Project".
  - **Group header:** "Set up on ▸", "Remove Project".
  - **Group host section:** "Remove from \<host\>".
  - **Removed:** "Copy to", "Move to", "Link with…" (including its "Choose
    local folder…") and "Unlink".
  - `ProjectTransferMenu` becomes `ProjectSetUpMenu`: copy mode only, with
    targets from `transferTargets(…, "copy")` and "Choose location…" last.
  - Delete `useMoveConfirm`.
- **Remove from \<host\> confirm** (`RemoveFromHostDialog`, new; or a
  `variant` of `RemoveProjectDialog`): "Remove manor from wsl-box? Files
  there aren't deleted. Its N workspaces on wsl-box won't show in Manor."
- **Set-up dialog** (`CloneToHostDialog`):
  - The `copy` and `addToGroup` modes merge into one `setUp` mode, titled
    "Set up \<name\> on \<host\>".
  - `move` stays, but only for the repair path below.
  - When the host is This machine, the dialog adds **"Use an existing
    folder…"** (`pickDirectory`). It sends the picked path as
    `targetDir`, with the origin URL, so `planClone` adopts the checkout.
    This replaces `linkLocalFolder`.
- **New Workspace** (`HostPicker.tsx`):
  - "Clone onto another host…" becomes "Set up on another host…".
  - It is offered for lone projects too: `hostsToCloneOnto` gives way to
    `transferTargets(…, "copy")`.
- **Project Settings:**
  - **Host section (`ProjectHostSection.tsx`):** shows the host card, then
    a "Set up on…" select (copy) where "Change host…" (move) was. Two
    repair actions stay for a missing repo:
    - "Clone it again" (`transferProject(id, sameHost, "move")`, the
      same-host re-clone fixed in ADR-213);
    - "Point at another folder…" (`switchProjectHost(id, host, picked)`).

    A host switch is no longer offered.
  - **Links section (`ProjectLinksSection.tsx`):** becomes a **Hosts**
    section, listing each host the project is set up on with a "Remove
    from \<host\>" button, plus "Keep separate…". The "Link with" select,
    per-member Unlink and "Unlink all" go. The member page loses its Unlink
    button.
- **Main and bridge:**
  - `transferProject`'s `move` mode stays for the repair path and Project
    Settings.
  - `linkProjects`, `unlinkProject`, `unlinkGroup` and `suggestLinks` stay
    as internals.
  - Delete renderer actions and IPC that nothing calls any more; knip will
    flag them.
- **Glossary:** add **Project**, **Set up on** and **Remove from host** to
  `CONTEXT.md`, and list *link*, *group*, *member* and *move* as avoided
  terms in UI copy.

### Out of scope

- Keeping tabs open across hosts.
- Handing off a workspace (the "open this branch on host X" idea).
- Copying `.env` files.
- A CLI or MCP `set-up` command (`create_workspace --host` already picks a
  member).

## Consequences

**What gets better:**

- One verb covers what used to be Move, Copy, Link, "Choose local folder…"
  and "Change host…". One counterpart covers what used to be Unlink,
  Unlink all and removing a member through the command palette.
- Every way in calls the same main operation.
- Projects with the same origin on two hosts join without being asked.
  Suggestion toasts go away, and so does the "Review / Dismiss" batch.

**What gets worse:**

- **Move is two steps.** ADR-179's move kept one project record (and its
  id). Set up + remove makes a new record and drops the old one.
  - Group-level settings survive, because `copySharedOnto` runs as the
    group dissolves.
  - Per-workspace metadata for non-main workspaces on the old host is
    lost. The confirm says so.
  - A project's id changes across a "move". Anything keyed by project id
    outside the project record would not follow: agent persistence,
    stats, notifications.

    A move today also orphans those workspaces' agents, so this is no
    worse in practice. Ticket 1 checks what is keyed by project id.
- **Auto-join is a behaviour change.** A user who meant to keep two
  same-origin projects apart gets one Undo toast, and later "Keep
  separate…". Persisting the dismissal makes both choices stick.
- **The repair actions still use move internally.** `transferProject`'s
  `move` mode can't be deleted.
- **Muscle memory:** users of ADR-192's Link UI lose it. It shipped
  recently and is labelled behind "Link with…", so not many users rely on
  it yet.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
