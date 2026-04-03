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

# ADR-089: Reorganize component directories by feature

## Context

All components live in a flat `src/components/` directory (~70 files). It's hard to reason about what belongs where. Components, their CSS modules, and related hooks are scattered across `src/components/` and `src/hooks/` with no grouping by feature.

The only existing grouping is `CommandPalette/` which already has its own subdirectory.

## Decision

Reorganize `src/components/` into feature-based directories. Components with `.module.css` files get their own subdirectory within the feature folder for CSS colocation. Feature-specific hooks move into their feature directory; shared hooks stay in `src/hooks/`.

### Target structure

```
src/
├── components/
│   ├── command-palette/           # Already grouped, rename from PascalCase
│   │   ├── CommandPalette/        # Has CSS
│   │   ├── GhostOverlay.tsx
│   │   ├── GitHubIcon.tsx
│   │   ├── GitHubIssueDetailView.tsx
│   │   ├── GitHubIssuesView.tsx
│   │   ├── IssueDetailSkeleton.tsx
│   │   ├── IssueDetailView.tsx
│   │   ├── IssueListSkeleton.tsx
│   │   ├── LinearIcon.tsx
│   │   ├── LinearIssuesView.tsx
│   │   ├── index.ts
│   │   ├── types.ts
│   │   ├── useCommands.tsx
│   │   ├── useCustomCommands.tsx
│   │   ├── useTaskCommands.tsx
│   │   ├── useWorkspaceCommands.tsx
│   │   └── utils.ts
│   ├── ports/
│   │   ├── PortBadge.tsx
│   │   ├── PortGroup.tsx
│   │   ├── PortsList.tsx
│   │   └── usePortsData.ts         # moved from src/hooks/
│   ├── settings/
│   │   ├── SettingsModal/           # Has CSS
│   │   ├── AppSettingsPage.tsx
│   │   ├── GitHubIntegrationSection.tsx
│   │   ├── IntegrationsPage.tsx
│   │   ├── KeybindingsPage.tsx
│   │   ├── LinearIntegrationSection.tsx
│   │   ├── LinearProjectSection.tsx
│   │   ├── NotificationsPage.tsx
│   │   ├── ProjectSettingsPage.tsx
│   │   └── ThemeSection.tsx
│   ├── sidebar/
│   │   ├── Sidebar/                 # Has CSS
│   │   ├── NewWorkspaceDialog/      # Has CSS
│   │   ├── ProjectSetupWizard/      # Has CSS
│   │   ├── TasksView/               # Has CSS
│   │   ├── WelcomeEmptyState/       # Has CSS
│   │   ├── EmptyStateShell.tsx
│   │   ├── GitHubNudge.tsx
│   │   ├── ProjectItem.tsx
│   │   ├── PrPopover.tsx
│   │   ├── MergeWorktreeDialog.tsx
│   │   ├── DeleteWorktreeDialog.tsx
│   │   ├── RemoveProjectDialog.tsx
│   │   ├── TasksList.tsx
│   │   └── WorkspaceEmptyState.tsx
│   ├── statusbar/
│   │   ├── StatusBar/               # Has CSS
│   │   ├── AboutModal/              # Has CSS
│   │   └── LinkedIssuesPopover/     # Has CSS
│   ├── tabbar/
│   │   ├── TabBar/                  # Has CSS
│   │   ├── Breadcrumbs/             # Has CSS
│   │   ├── SessionButton.tsx
│   │   └── TabAgentDot.tsx
│   ├── ui/
│   │   ├── AgentDot/                # Has CSS
│   │   ├── EmptyState/              # Has CSS
│   │   ├── SpinnerLoader/           # Has CSS
│   │   ├── Switch/                  # Has CSS
│   │   ├── Toast/                   # Has CSS
│   │   ├── Tooltip/                 # Has CSS
│   │   ├── ManorLogo.tsx
│   │   └── ToastItem.tsx
│   ├── workspace-panes/
│   │   ├── BrowserPane/             # Has CSS
│   │   ├── PaneLayout/              # Has CSS
│   │   ├── TerminalPane/            # Has CSS
│   │   ├── LeafPane.tsx
│   │   ├── PaneDropZone.tsx
│   │   ├── SplitLayout.tsx
│   │   └── PaneDragContext.tsx       # moved from src/contexts/
│   └── CloseAgentPaneDialog.tsx      # stays flat, used by App.tsx
├── hooks/
│   ├── useAutoUpdate.ts
│   ├── useBranchWatcher.ts
│   ├── useDebouncedAgentStatus.ts    # multi-consumer
│   ├── useDiffWatcher.ts
│   ├── useListKeyboardNav.ts
│   ├── useMountEffect.ts
│   ├── useProjectAgentStatus.ts      # multi-consumer
│   ├── useSessionAgentStatus.ts      # multi-consumer
│   ├── useSessionTitle.ts            # multi-consumer
│   ├── useTerminalConnection.ts
│   ├── useTerminalHotkeys.ts
│   ├── useTerminalLifecycle.ts
│   ├── useTerminalResize.ts
│   ├── useTerminalStream.ts
│   ├── useWorkspaceAgentStatus.ts    # multi-consumer
│   ├── useWorkspaceDrag.ts
│   └── usePrWatcher.ts
```

### Import update strategy

All imports across the codebase must be updated to reflect new paths. No barrel files — import directly from the file.

### Components with CSS (get own subdirectory)

These 20 components have `.module.css` and get `ComponentName/ComponentName.tsx` + `ComponentName.module.css`:

AgentDot, AboutModal, Breadcrumbs, BrowserPane, CommandPalette, EmptyState, LinkedIssuesPopover, NewWorkspaceDialog, PaneLayout, ProjectSetupWizard, SettingsModal, Sidebar, SpinnerLoader, StatusBar, Switch, TabBar, TasksView, TerminalPane, Toast, Tooltip, WelcomeEmptyState

## Consequences

- **Better**: Feature discovery is immediate — related files are colocated
- **Better**: CSS modules sit next to their component
- **Better**: Adding new components has a clear "where does this go" answer
- **Worse**: Large number of import path changes in one shot — risk of broken imports
- **Worse**: Git history for moved files requires `git log --follow`
- **Mitigated**: Typecheck + build verification catches any broken imports

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
