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

# ADR-219: Phone drawer puts agents first

## Context

On a phone the sidebar lives in `SidebarDrawer` (ADR-181 D3), which renders the
desk's `Sidebar` as is: nav rows (Dashboard, Tasks, Search, Notifications), then
the full Projects → workspaces tree, then a small `AgentsList` at the bottom.
On a phone you mostly check on agents and answer the ones waiting on you, but
the projects tree takes most of the drawer and pushes agents into a cramped
strip at the bottom.

We explored layouts on a design canvas
(https://claude.ai/artifact/PrGRDYYkMYwg1kQkNGAkbk). The user chose **1a**
(board `HeadSlim.dc.html`): agents that need input are pinned at the top as cards,
the other agents are grouped by project, the top has a slim action bar, and the
bottom has a Projects row plus an icon nav. The user also asked for a way to
reach Settings, which the phone currently can only reach through the palette.

## Decision

The phone drawer gets its own agents-first content. `Sidebar` and the desk
layout do not change.

1. **A pure model** — `src/components/phone/AgentsDrawer/agents-drawer-model.ts`
   exports `buildAgentsDrawerModel({ agents, statusByPane, projects })`, returning
   `{ needsYou: AgentInfo[], groups: { projectId, projectName, color, agents }[] }`.
   - `agents` comes from `useVisibleAgents()`, the same set the desk Agents list shows.
   - `needsYou` = agents whose pane's Agent status is `requires_input`, newest
     `updatedAt` first.
   - `groups` = every other agent, grouped by `projectId`, with groups ordered
     like `useProjectStore().projects`. Within a group, `thinking`/`working` come
     first, then `error`, then `responded`/`idle`/no status, each sorted by newest `updatedAt`.
     A project with no remaining agents gets no group.
   - The model reads statuses as given and never re-derives them (Status
     reconciler rule, CONTEXT.md).

2. **`PhoneAgentsPanel`** — `src/components/phone/AgentsDrawer/PhoneAgentsPanel.tsx`
   plus a `.module.css`, laid out top to bottom:
   - **Top bar:** a `+ New agent` pill (`Button`) on the left and a Settings gear
     icon button (`Button` + `Tooltip`, `aria-label="Settings"`) on the right.
   - **Needs you · N** section (hidden when empty): one card per agent showing
     its title (`useAgentDisplay`), relative time, a one-line message and a
     project color square plus `projectName / workspace`. The message is the
     `body` of the newest notification whose `target` is
     `{ type: "agent", agentId }` (from `useNotificationStore`), or
     "Waiting for your input" if there is none.
   - A divider, then **one section per project group**: a header with the
     project color square (`projectColorStyle`) and name, then rows showing
     `AgentDot` + title + a trailing label (`working`/`thinking`/`error`, or the
     relative time for responded/idle).
   - An empty state ("No agents running" + New agent) when there are no visible agents.
   - **Bottom area:** a `Projects` row reading `N · M workspaces ›`, and below it
     an icon nav — Dashboard, Tasks, Search, Notifications (with an unread dot) —
     that keeps the existing test ids `home-row`, `tasks-row`, `search-row` and
     `notifications-row`, so current E2E selectors still work.
   - Tapping an agent calls `navigateToAgent(agent)` and closes the drawer.
     Dashboard and Tasks reuse `setActiveWorkspace(HOME_PATH)` and
     `showTasksView()`, as `Sidebar` does.

3. **`SidebarDrawer` gets two views**, held in local state:
   `"agents"` (the default) renders `PhoneAgentsPanel`; `"projects"` renders a
   back header ("‹ Agents") above the existing `Sidebar`, so the full project
   tree, add-project and the workspace menus stay reachable without being
   rebuilt. The view resets to `"agents"` whenever the drawer closes. Swipe and
   edge-swipe gestures stay as they are.

4. **Wiring:** `SidebarDrawer` and `PhoneChrome` gain `onNewAgent` and
   `onOpenSettings`. `App` passes the existing `handleNewAgent` (it starts an
   agent in the active workspace and opens it as a chat on the phone) and
   `handleOpenSettings`. Both close the drawer first.

## Consequences

- Better: agents waiting on you are the first thing in the drawer; Settings
  is one tap away on a phone; Dashboard, Tasks, Search and Notifications take
  one compact row instead of four full rows.
- The project tree is one tap deeper on a phone (Projects row). Switching to
  a workspace that has no agent now takes two taps.
- New agent starts in the **active** workspace, like the tab bar's +. Choosing
  a different project or workspace first is not covered here.
- Agent rows in the panel have no rename/close context menu in v1 (the desk
  `AgentsList` keeps its). A long-press menu can follow if it's missed.
- The card message depends on a notification existing for that agent. Agents
  that ask without sending a notification show the fallback text.
- `Sidebar` is untouched, so the desk cannot regress. The cost is a second
  agent list component to maintain beside `AgentsList`. The shared
  `useVisibleAgents` and `useAgentDisplay` hooks keep both lists consistent.
- E2E tests that tap `workspace-item` inside the drawer must first open the
  Projects view.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
