---
title: Convert interface to type for all component props
status: done
priority: medium
assignee: haiku
blocked_by: []
---

# Convert interface to type for all component props

Per the React patterns skill, component props must use `type` instead of `interface`. Find all `interface ...Props` declarations in component files and convert to `type ... = { ... }`.

## Files to touch

- `src/components/SplitLayout.tsx` — `interface SplitLayoutProps` to `type SplitLayoutProps`
- `src/components/AgentDot.tsx` — `interface AgentDotProps` to `type AgentDotProps`
- `src/components/PrPopover.tsx` — `interface PrPopoverProps` to `type PrPopoverProps`
- `src/components/SettingsModal.tsx` — `interface SettingsModalProps` and `interface SettingsTabButtonProps` to `type`
- `src/components/SpinnerLoader.tsx` — `interface SpinnerLoaderProps` to `type SpinnerLoaderProps`
- `src/components/TasksView.tsx` — `interface TaskRowProps` and `interface TasksModalProps` to `type`
- `src/components/LinkedIssuesPopover.tsx` — `interface LinkedIssuesPopoverProps` to `type`
- `src/components/TerminalPane.tsx` — `interface TerminalPaneProps` to `type TerminalPaneProps`
- `src/components/CommandPalette/GitHubIssuesView.tsx` — `interface GitHubIssuesViewProps` to `type`
- `src/components/CommandPalette/LinearIssuesView.tsx` — `interface LinearIssuesViewProps` to `type`
- `src/components/NewWorkspaceDialog.tsx` — `interface NewWorkspaceDialogProps` to `type`
- `src/components/CommandPalette/IssueDetailView.tsx` — `interface IssueDetailViewProps` to `type`
- `src/components/CommandPalette/GitHubIssueDetailView.tsx` — `interface GitHubIssueDetailViewProps` to `type`
- `src/components/BrowserPane.tsx` — `interface BrowserPaneProps` to `type` (keep WebviewElement, WebviewNavigateEvent, etc. as interface since they're not component props)
- `src/components/ProjectSetupWizard.tsx` — `interface ProjectSetupWizardProps` to `type`
- `src/components/GitHubNudge.tsx` — `interface GitHubNudgeProps` to `type`
- `src/components/WorkspaceEmptyState.tsx` — `interface WorkspaceEmptyStateProps` to `type`

## Pattern

For each file:
```tsx
// Before
interface FooProps {
  bar: string;
  baz: number;
}

// After
type FooProps = {
  bar: string;
  baz: number;
};
```

Only convert props types (types used as React component parameters). Do NOT convert non-props interfaces like `WebviewElement`, `DiscoveredAgent`, etc.
