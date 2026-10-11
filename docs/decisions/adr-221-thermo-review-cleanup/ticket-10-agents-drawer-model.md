---
title: Agents drawer model owns its derivations
status: todo
priority: medium
assignee: opus
blocked_by: [9]
---

# Agents drawer model owns its derivations

`PhoneAgentsPanel.tsx:46-65, 87-108` re-derives `workspaceLabel` (try/catch around `agentWorkspaceKey`), a `projectById` map, `totalWorkspaces`, `trailingLabel` and a `statusByPane` adapter (copied in `agents-drawer-model.test.ts:23-28`). `agents-drawer-model.ts` takes `projects` but only uses id/name/color.

Do:
1. Model returns everything the panel renders: `needsYou: { agent, projectName, color, workspaceLabel }[]`, groups whose rows already carry their trailing label, and a `projectsSummary`. Reuse `resolveAgentContext` (`src/lib/home-dashboard.ts:87`) for project/workspace resolution; take `paneAgentStatus` directly like `needsYouItems` (`home-dashboard.ts:128`). Panel becomes pure render; delete `statusByPane` and its fixture copy.
2. One `rowState(status) → { rank, label }` replaces `rank()` (`agents-drawer-model.ts:22-26`) and `trailingLabel()` (`PhoneAgentsPanel.tsx:60-65`).
3. `group.projectId` holds the project *name* when id is null (`:54,77`) — rename to `key`. Replace the `-1` sentinel sort (`:75,86-93`) with two passes: known projects in store order, then unknown by name.
4. Shared `useSidebarNav(onNavigate)` hook for `handleSelectHome`/`handleShowTasks` (copied at `PhoneAgentsPanel.tsx:118-126` from `Sidebar.tsx:106-114`); extract the unread-count selector + badge shared by `NotificationsIcon` (`:364-392`) and Sidebar's `NotificationsRow` (`:456-484`).
5. Time: one `byUpdatedDesc` comparator (Date.parse based) and one age formatter next to `src/lib/relative-time` (or wherever `relativeShort` lives); use in the drawer model, panel (`ago()` wrapper goes) and `recentWorkspaceAgents` in `phone-empty-state.ts`.
6. "Needs you": derive the drawer list from `needsYouItems` filtered to tier `"input"` so the label means the same input-needed subset, or rename the drawer section to "Waiting on you" — pick derive-from-`needsYouItems` unless the shapes fight it; keep E2E test ids.
7. Update `agents-drawer-model.test.ts`, `phone-empty-state.test.ts`.

## Files to touch
- `src/components/phone/AgentsDrawer/agents-drawer-model.ts` (+test)
- `src/components/phone/AgentsDrawer/PhoneAgentsPanel.tsx`
- `src/components/sidebar/Sidebar/Sidebar.tsx`
- `src/components/phone/phone-empty-state.ts` (+test)
- `src/lib/home-dashboard.ts` (only if a small export is needed)
- relative-time module
