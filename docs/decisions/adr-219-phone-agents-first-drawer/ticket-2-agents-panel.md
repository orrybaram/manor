---
title: PhoneAgentsPanel component
status: done
priority: high
assignee: opus
blocked_by: [1]
---

# PhoneAgentsPanel component

Build `PhoneAgentsPanel` per ADR-219 Decision §2. The visual reference is the board `HeadSlim.dc.html` on https://claude.ai/artifact/PrGRDYYkMYwg1kQkNGAkbk. Use the app's theme CSS variables (look at `SidebarDrawer.module.css`, `Sidebar.module.css`, `AgentsList.module.css`) instead of the mockup's hex values. Use `--yellow`/warning tones for "Needs you".

Props:
```ts
type PhoneAgentsPanelProps = {
  onNewAgent: () => void;
  onOpenSettings: () => void;
  onOpenProjects: () => void;   // switches the drawer to its projects view
  onOpenSearch?: () => void;
  onOpenNotifications?: () => void;
  onNavigate: () => void;       // closes the drawer after any navigation
};
```

Implementation notes:
- Data: `useVisibleAgents()`, `useAppStore(s => s.paneAgentStatus)` mapped to `statusByPane` (memoized), `useProjectStore(s => s.projects)` → `buildAgentsDrawerModel` in a `useMemo`.
- Card and row each render their agent through a small child component that calls `useAgentDisplay(agent)` for the title (hooks per row, as `AgentRow` does in `src/components/sidebar/AgentsList.tsx`).
- Needs-you message: the newest `useNotificationStore` notification with `target?.type === "agent" && target.agentId === agent.id`, its `body`, else "Waiting for your input". Select it narrowly so unrelated notifications don't re-render every card.
- Workspace label: the workspace name for `agent.workspacePath`, looked up from the project's workspaces (use the helper the sidebar already uses for workspace names if there is one); fall back to the basename of the path.
- Relative time: reuse an existing relative-time util if one exists (grep `formatRelative`/`timeAgo`), else add a tiny local one.
- Status dot: `AgentDot` from `ui/AgentDot`.
- Agent tap: `navigateToAgent(agent)` then `onNavigate()`.
- Dashboard: `useAppStore.getState().setActiveWorkspace(HOME_PATH)`; Tasks: `showTasksView()`; then `onNavigate()`. Mirror `Sidebar.tsx` `handleSelectHome` / `handleShowTasks`.
- Projects row: shows `${projects.length} · ${totalWorkspaces} workspaces`, calls `onOpenProjects`, test id `drawer-projects-row`.
- Icon nav test ids: `home-row`, `tasks-row`, `search-row`, `notifications-row` (existing E2E uses these within `sidebar-drawer`). Notifications shows a dot when `unreadCount > 0`.
- Top bar: New agent pill test id `drawer-new-agent`; gear test id `drawer-settings`.
- Agent rows/cards: test id `drawer-agent-row` with `data-agent-id`; needs-you cards also get `data-needs-you`.
- Empty state when there are no visible agents.
- Use `Button`/`Tooltip` from `src/components/ui` (repo rule: no raw `<button>`). Touch targets ≥44px. Lucide icons imported per-file like `Sidebar.tsx` does (`lucide-react/dist/esm/icons/...`).

## Files to touch
- `src/components/phone/AgentsDrawer/PhoneAgentsPanel.tsx` — new
- `src/components/phone/AgentsDrawer/PhoneAgentsPanel.module.css` — new
