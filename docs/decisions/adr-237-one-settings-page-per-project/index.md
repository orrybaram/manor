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

# ADR-237: One settings page per project

## Context

ADR-193 split a project set up on several hosts into a group page
("Shared") plus one nested nav row and one page per host (the "member
page": Location, Host, Worktrees, Ports). ADR-214 then made "Set up on" the
one way a project gains a host and added a Hosts list with "Remove from
<host>" and "Keep separate…" to the group page. ADR-229 D8 and ADR-233
gave hosts their own Settings → Hosts page, with everything about a host's
connection, devices, supervision and keys.

The result repeats itself. On the member page for `homebook` on `blade`
the host is named six times: the nav row under the project, the heading
"homebook on blade", a Host section whose hint links to "Manage hosts"
(the nav already has Hosts), a `HostCard` with the connection status (a
copy of the Hosts page row), that card's footer ("Copy ssh command", a
host concern, beside "Set up on…", a project concern), and the group
page's Hosts list. The path appears under Location and again under each
host on the group page. The group page's hint sends the user to "the host
settings" to add a host, while the Set up on… control sits on a member
page. A lone project's page is a different component again, with its own
section order. And the theme picker, a search field over an always-open
280px list, takes a third of the first screen for a setting most
projects leave at "Global theme".

## Decision

### D1. The nav lists one row per project

Under **Projects** the settings nav shows one row per project, lone or
set up on several hosts, in sidebar order. The nested per-host rows
(`navItemNested2`, `settings-nav-member-*`) go away. The page kinds stay
(`{type:"project"}` for a lone project, `{type:"group"}` for one set up on
several hosts): the nav key, active state and the "group dissolved"
fallback in `SettingsModal.tsx` depend on them. What changes is that both
kinds render the same page component.

### D2. One page, one section order

`ProjectSettingsPage` takes the lead project and its members (`[project]`
for a lone project) and renders, in order: **General** (Name and Theme in
a two-column grid, Color under them), **Linear**, **Hosts**, **Agent**,
**Commands**. `GroupSettingsPage`, `MemberSettingsPage`, `PathFields`,
`WorktreesSection`, `PortsSection`, `ProjectHostSection` and
`ProjectSetUpOnSection` are deleted; their contents move into the Hosts
section (D3).

### D3. The Hosts section owns everything per host

A new `ProjectHostsSection` (`src/components/settings/ProjectHostsSection/`):

- A header row: the section title **Hosts** on the left, the **Set up
  on…** `SearchableSelect` on the right (the options `ProjectHostSection`
  built from `transferTargets(…, "copy")`, plus "Add new host…" which opens
  `AddSshHostForm` inline; the "Show all hosts" link when `hasHiddenPods`).
  The hint under it reads "Where this project is set up. Each host keeps
  its own path, worktrees and ports." The e2e spec
  `tests/e2e/set-up-on-host.spec.ts` matches its first sentence.
- One collapsible row per host the project is set up on, in `memberIds`
  order, using `HostRowShell` from `HostsPage/HostRow.tsx` (ADR-233 D1).
  The shell gains `defaultOpen` and `detail` props. The row header shows
  the host icon (`Laptop` for this machine, `HostStateIcon` for a remote
  host), the host's display name, a status dot and one word from a pure
  helper `projectHostStatus(hostId, display)` ("Local" for this machine,
  else `display.status` in `display.tone`), and the member's path as a
  mono detail line. The open body holds Default branch (static), Worktree
  path with its default hint, Start and Teardown scripts, the Named
  preview URLs switch with `previewHostname`, and the missing-repo repair
  rows (Clone it again / Point at another folder…) when a connected
  remote host reports the path missing. Its footer has a link button
  "Open <host> in Hosts" (`useSettingsNav` to `{type:"hosts"}`, section
  `host-<hostId>` or `host-local`), a spacer, and "Remove from <host>"
  (`openRemoveFromHost`) when the project is on more than one host.
- A lone project's single row starts open. A project on several hosts
  starts with every row closed; the row a settings jump names opens, as
  `HostRowShell` already does for `useSettingsJump`.
- Under the list, "Keep separate…" with its confirm dialog, when the
  project is on more than one host.

`HostCard` and `HostCardRow` lose their last user and are deleted;
`CopySshCommand` moves to its own file for `HostRow.tsx`.
`LocalHostDetails` in `HostStatusDetails.tsx` goes with it.

Rejected: a new `ProjectHostRow` shell with its own CSS (duplicates the
Hosts page's row styles, which would drift) and extracting the shell into
a shared `src/components/hosts/` module (clean, but a four-file move with
no functional gain now; `ProjectHostSection` already imports
`AddSshHostForm` from `../HostsPage/`, so the cross-import has precedent).

### D4. The theme picker is a select

`ProjectThemeSelector` renders a `SearchableSelect`: a one-row trigger
showing the chosen theme's name, badge and six colour dots, opening a
popover with search and the same list as today (check mark, name,
Default / Ghostty / Built-in badge, dots). `SearchableSelect` gains an
optional `trailing` node per option (rendered after the label and shown
on the trigger for the selected option) and a `listMaxHeight` prop.
Keyboard navigation comes from the component; `useListKeyboardNav` leaves
the project picker. The Appearance page's `ThemeSection` keeps its big
list, since there the list is the page's content, so the `.theme*`
styles in `SettingsModal.module.css` stay.

Rejected: a dedicated theme popover, which would re-implement search,
highlight, scroll-into-view and the combobox aria that `SearchableSelect`
already has.

### D5. Deep links and search

`requestUi({type:"open-project-settings", projectId, section:"project-host"})`
(sent from `HostPopover`, `HostIndicator` and the set-up toast in
`project-store`) keeps its shape. `pageForProject` opens the project's one
page (the group page for a member id); a new pure `projectJumpId(section,
projectId, grouped)` turns `project-host` for a member into
`project-host-<projectId>`, the member row's section id, so the row opens
and scrolls into view. `MACHINE_SECTION_IDS`, `GROUP_SECTIONS` and
`MEMBER_SECTIONS` go; `PROJECT_SECTIONS` becomes General, Linear, Hosts
(`project-host`, with keywords for host, set up, remove, separate,
worktree, branch, path, port, preview), Agent, Commands, indexed once per
project row. `settings-search.test.ts` is rewritten to match.

## Consequences

**Better**
- A host is named once on a project page, in its row. The path is shown
  once. Nothing on a project page repeats the Hosts page.
- The nav has one row per project, so it matches the sidebar.
- A lone project and one set up on several hosts share one component and
  one section order.
- The theme setting takes one row until it is opened.

**Harder / risks**
- Per-host fields (worktrees, ports) are one click deeper on a
  multi-host project, inside a closed row.
- Search results for "worktree" or "port" land on the Hosts section
  heading, not a specific host's field.
- Deep links that named `project-location`, `project-worktrees` or
  `project-ports` no longer have a target; none are sent today.
- `knip` runs in `pnpm test`, so a ticket that stops importing a file
  must delete it in the same commit.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
