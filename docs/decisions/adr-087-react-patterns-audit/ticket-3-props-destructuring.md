---
title: Fix props destructuring pattern in all components
status: done
priority: medium
assignee: sonnet
blocked_by: [1, 2]
---

# Fix props destructuring pattern in all components

Per the React patterns skill, all components must:
1. Accept `props` as the parameter name (not inline destructuring)
2. Destructure on the first line of the component body
3. Add a blank line after the destructuring before the rest of the component logic

## Pattern

```tsx
// Before
function MyComponent({ title, count }: MyComponentProps) {
  return <Text>{title}: {count}</Text>;
}

// After
function MyComponent(props: MyComponentProps) {
  const { title, count } = props;

  return <Text>{title}: {count}</Text>;
}
```

For components with inline type definitions in the parameter (no named type), create a named type first:

```tsx
// Before
export function TabAgentDot({ sessionId }: { sessionId: string }) {

// After
type TabAgentDotProps = {
  sessionId: string;
};

export function TabAgentDot(props: TabAgentDotProps) {
  const { sessionId } = props;
```

For `forwardRef` components, the inner function follows the same pattern:
```tsx
// Before
forwardRef<Ref, Props>(function Foo({ bar, baz }, ref) {

// After
forwardRef<Ref, Props>(function Foo(props, ref) {
  const { bar, baz } = props;
```

For components using `...rest` spread:
```tsx
// Before
function Switch({ className, ...rest }: SwitchProps) {

// After
function Switch(props: SwitchProps) {
  const { className, ...rest } = props;
```

## Files to touch

Every component file in `src/components/` and `src/contexts/` that uses inline destructuring. Based on the audit, this includes approximately 50 files. The full list:

- `src/components/SplitLayout.tsx`
- `src/components/LinearProjectSection.tsx`
- `src/components/TabAgentDot.tsx`
- `src/components/Switch.tsx`
- `src/components/Breadcrumbs.tsx`
- `src/components/AgentDot.tsx`
- `src/components/PaneLayout.tsx`
- `src/components/PaneDropZone.tsx`
- `src/components/PrPopover.tsx`
- `src/components/RemoveProjectDialog.tsx`
- `src/components/SettingsModal.tsx`
- `src/components/SpinnerLoader.tsx`
- `src/components/TasksView.tsx`
- `src/components/ToastItem.tsx`
- `src/contexts/PaneDragContext.tsx`
- `src/components/PortBadge.tsx`
- `src/components/Tooltip.tsx`
- `src/components/AboutModal.tsx`
- `src/components/TerminalPane.tsx`
- `src/components/StatusBar.tsx`
- `src/components/EmptyStateShell.tsx`
- `src/components/CommandPalette/GitHubIcon.tsx`
- `src/components/CommandPalette/LinearIcon.tsx`
- `src/components/CommandPalette/IssueDetailSkeleton.tsx`
- `src/components/CommandPalette/GitHubIssuesView.tsx`
- `src/components/CommandPalette/LinearIssuesView.tsx`
- `src/components/DeleteWorktreeDialog.tsx`
- `src/components/PortGroup.tsx`
- `src/components/Sidebar.tsx`
- `src/components/CloseAgentPaneDialog.tsx`
- `src/components/MergeWorktreeDialog.tsx`
- `src/components/WelcomeEmptyState.tsx`
- `src/components/GitHubNudge.tsx`
- `src/components/LinkedIssuesPopover.tsx`
- `src/components/SessionButton.tsx`
- `src/components/TabBar.tsx`
- `src/components/TasksList.tsx`
- `src/components/LeafPane.tsx`
- `src/components/ProjectSetupWizard.tsx`
- `src/components/CommandPalette/IssueDetailView.tsx`
- `src/components/CommandPalette/GitHubIssueDetailView.tsx`
- `src/components/NewWorkspaceDialog.tsx`
- `src/components/WorkspaceEmptyState.tsx`
- `src/components/CommandPalette/CommandPalette.tsx`
- `src/components/ProjectItem.tsx`
- `src/components/BrowserPane.tsx`
- `src/components/NotificationsPage.tsx`
- `src/components/PortsList.tsx`
- `src/components/ThemeSection.tsx`
- `src/components/KeybindingsPage.tsx`
- `src/components/ProjectSettingsPage.tsx`

For components that take no props (e.g., `ManorLogo`, `Toast`), no changes needed.

**Important**: This ticket is blocked by tickets 1 and 2 because those tickets modify the same files. Running this after ensures no merge conflicts.

**Important**: For the `BrowserPane` forwardRef component, the inner function signature is `function BrowserPane({ paneId, initialUrl, onNavStateChange }, ref)`. Convert to `function BrowserPane(props, ref)` with `const { paneId, initialUrl, onNavStateChange } = props;` on the first line.
