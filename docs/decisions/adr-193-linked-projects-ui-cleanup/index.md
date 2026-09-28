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

# ADR-193: Linked projects UI cleanup

Follows ADR-192 (linked projects). No change to the group model's invariants.

## Context

ADR-192 shipped linked projects, but the UI it landed with is hard to read:

- **Sidebar.** A group renders its header, then one `ProjectItem` in
  `variant="section"` per host. Each section header is a full project header
  row (chevron + a filled `HostIndicator` chip for a remote host, a
  `LocalHostLabel` for this machine). The section is itself a `.project`, so a
  selected section draws a second project-color left border inside the
  group's, and the local label takes the project color. Section headers look
  like workspace rows, and the nested colored bars make it unclear which rows
  belong to which host (see the screenshot on the request: `retrograde` →
  `blade` chip → `blade` workspace, then a pink "This machine" → `local`).
- **Settings.** A group has one settings page (`ProjectSettingsPage`,
  `project.group` branch). It stacks the shared section, then every member's
  full per-host block (path, **theme**, host, ports, commands, worktrees) on
  one long scroll with only a `HostLabel` between them. It is hard to tell
  what is shared and whose settings you are editing. Each member can still
  pick its own theme, which contradicts "one repo, one entry".
- **Linking a remote repo to a local checkout** needs the local folder to be a
  Manor project first: add it via "Add project", then "Link with…". There is
  no one-step path.

## Decision

### 1. Theme and commands become shared group settings

`GroupSharedFields` (`electron/projects/types.ts`) gains `themeName` and
`commands`. `resolveShared`, `sharedFrom`, `copySharedOnto` and
`updateGroup` in `electron/projects/project-groups.ts` handle them like
`color` / `agentCommand` (an absent group value falls through to the member;
a leaving member takes the group's values). The renderer already reads
`project.themeName` / `project.commands` from `ProjectInfo`, so theme
application and the command palette keep working unchanged. Per-member theme
picking is removed from the UI.

What stays per member (machine-specific): **path / default branch, host,
worktree path + start/teardown scripts, named preview URLs (portless)**.

### 2. Settings: group page + nested member pages

`SettingsModal` nav under **Projects**:

```
Projects
  manor                 ← lone project, unchanged page
  retrograde            ← group: shared settings page
     ☁ blade            ← member page (machine-specific)
     💻 This machine     ← member page
```

- New page kind `{ type: "group"; groupId }`. Its page (`GroupSettingsPage`)
  shows **Shared**: name, color, theme, Linear, agent command, commands, and
  **Linked projects** (member list with host + path + Unlink, "Link with",
  "Unlink all").
- A member row opens `{ type: "project", projectId }`; for a grouped project
  `ProjectSettingsPage` renders `MemberSettingsPage`: a header ("retrograde on
  blade" with the host label), **Location** (path, default branch, Unlink),
  **Host** (`ProjectHostSection`), **Worktrees**, **Ports**. No name, color,
  theme, agent or commands.
- Member rows are nested one level under the group row (indent + host icon,
  `navItemNested` depth 2). They are always visible; the group row is not a
  collapsible toggle.
- `settings-search.ts` indexes shared sections under the group page and
  machine sections under each member page (page label
  `"retrograde · blade"`). `initialProjectId` for a grouped project opens the
  group page, unless `initialSection` names a machine section
  (`project-host`, `project-worktrees`, `project-ports`), which opens that
  member's page.
- The per-member anchor suffixing (`SectionAnchor`) goes away: every page
  shows one project's sections once.

### 3. Sidebar group rendering

Only styling/markup in `ProjectGroupItem`, the `section` variant of
`ProjectItem`, and `ProjectItem.module.css`:

- **Projects** are set apart by space and weight, not lines: project names
  are 13.5px semibold, an expanded project's list has 14px of bottom padding
  (collapsed projects stay tight), and the
  separators between projects and the selected project's left color bar are
  removed. The selected project is marked by its colored name.
- **Host heading** (a group's section header, and the host line above a
  remote-only project's workspaces): 10px uppercase with letter-spacing,
  `--text-dim`, host icon (`Laptop` / `Cloud`) + host name, and a connection
  dot on the right for a remote host. It is outdented: its icon sits in the
  chevron's column while workspaces start under the project name, so it reads
  as a heading, not a row. No chip, rule or chevron; clicking a group's host
  label collapses that section and shows its workspace count. An expanded
  section's list carries 16px of space below it; collapsed sections sit 4px
  apart.
- **Project names carry no icons.** The link icon on a group and the cloud on
  a remote project are removed; a remote-only project shows its host as a
  host heading instead. A group with a host away still shows its
  Partial/Offline state beside the name.
- **Indentation.** Workspace rows (in every project, linked or not) start
  under the project name, past the chevron.
- (Revised twice after review, using mockups: the first cut left host labels
  at the same x as workspace names; a small-caps divider version made host
  labels as loud as project names, so projects blended together.)
- Offline dimming (`.sectionOffline`) and all behavior (context menu,
  multi-select, keyboard nav, collapse keys, test ids) are unchanged.

### 4. "Choose local folder…" when linking a remote project

On a project whose host is remote and whose group (if any) has no local
member, the **Link with…** submenu (sidebar) and the **Link with** control
(group page / lone project page) get a trailing item **"Choose local
folder…"**. It:

1. opens `dialog.openDirectory`;
2. if the folder is already a local project, links that project;
3. otherwise adds it (`projects.add`, name = the remote project's name) and
   links it with the remote project;
4. shows an error toast if add/link throws (e.g. not a git repo).

This is a new store action `linkLocalFolder(projectId)` in
`src/store/project-store.ts`. `addProject` returns the created `ProjectInfo`
so the action can link it, and the action suppresses the origin link
suggestion for the pair it just linked. "Link with…" is no longer disabled
when the only choice is "Choose local folder…".

## Consequences

**Better**
- A linked repo reads as one entry with clearly labeled host sub-sections.
- Settings separate "what's shared" from "what's different on this machine";
  each page edits exactly one thing.
- One theme and one command list per repo, as users expect.
- Linking a remote repo to a local checkout is one action.

**Harder / risks**
- Members that had different themes/commands: the group has no value until
  it's set, so each member keeps showing its own old value (fall-through).
  Picking a theme/command list on the group page overwrites for all. No
  migration; acceptable.
- Settings deep links that pointed at a group member's page with a shared
  section id now land on the group page. Search results change labels.
- A per-host command (e.g. a script only on the box) can no longer differ per
  host. Worktree start/teardown scripts still can.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
