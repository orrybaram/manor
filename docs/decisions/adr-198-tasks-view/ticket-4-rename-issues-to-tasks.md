---
title: Rename Issues to Tasks in UI copy
status: in-progress
priority: medium
assignee: sonnet
blocked_by: [2, 3]
---

# Rename Issues to Tasks in UI copy

ADR-198 §5. Change user-facing strings only — not identifiers, IPC channels,
MCP tool descriptions, or comments.

Rename (Issue→Task, Issues→Tasks, issue→task, issues→tasks):
- `src/components/command-palette/CommandPalette.tsx` (~L311, 321, 436, 437, 446; file has a raw \u001f byte, use `grep -a`)
- `GitHubIssuesView.tsx` (~L98, 138), `LinearIssuesView.tsx` (~L119, 175)
- `GitHubIssueDetailView.tsx` (~L103, 119, 136) toasts
- `src/components/statusbar/LinkedIssuesPopover/LinkedIssuesPopover.tsx` (~L170, 255, 303, 321, 329, 343, 393)
- `src/components/statusbar/StatusBar/StatusBar.tsx` (~L205)
- `src/lib/start-issue-work.ts` (~L32)
- `src/components/sidebar/HomeDashboard/HomeDashboard.tsx` (~L208, 271)
- `src/components/sidebar/useIssuesShortcut.tsx` (~L115) → "Your Tasks"
- `src/components/sidebar/GitHubNudge.tsx` (~L141)
- `electron/app-menu-template.ts` (~L198) "Your Issues" → "Your Tasks"
- `src/components/settings/LinearIntegrationSection.tsx` (~L81),
  `src/components/sidebar/ProjectSetupWizard/ProjectSetupWizard.tsx` (~L520),
  settings-search keywords (~L128, 172: add "tasks", keep "issues")
- Grep `src/` again for any remaining user-visible "issue" strings.

Keep: "Report an Issue on GitHub" (app menu) and FeedbackModal copy.

Behavior: the "Your Tasks" launcher and `your-issues` menu command
(`src/lib/menu-handlers.ts` ~L247) now call `useAppStore.getState().showTasksView()`
instead of opening the palette view. HomeDashboard "All tasks" link also
opens the Tasks view.

Update any tests asserting the old strings.

## Files to touch
- the files listed above, plus `src/lib/menu-handlers.ts`
