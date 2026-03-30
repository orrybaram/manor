---
title: Build linked issues popover with detail navigation
status: done
priority: high
assignee: opus
blocked_by: [1, 3]
---

# Build linked issues popover with detail navigation

Create a popover anchored to the status bar Linear section that shows linked issues with live details, supports navigation to the full IssueDetailView, and allows unlinking.

## Implementation

### 1. Create `LinkedIssuesPopover` component

New file: `src/components/LinkedIssuesPopover.tsx` (and `.module.css`).

**Props:**
```typescript
interface LinkedIssuesPopoverProps {
  issues: LinkedIssue[];
  anchorRef: React.RefObject<HTMLElement>;
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  workspacePath: string;
}
```

**Two views within the popover:**

**List view (default):**
- Shows all linked issues in a list.
- Each row: identifier (bold) + title (truncated).
- On popover open, fetch live details for all issues via `window.electronAPI.linear.getIssueDetail(issueId)` for each.
- Once fetched, show status badge and assignee avatar/name alongside each row.
- Loading skeleton while fetching.
- Click a row → switch to detail view for that issue.
- Right-click a row → context menu with "Unlink issue" option.

**Detail view:**
- Render `IssueDetailView` component inline in the popover.
- Pass `onBack` to return to list view.
- Pass `onClose` to close the entire popover.
- Pass existing `onNewWorkspace` and `onNewTaskWithPrompt` props (sourced from the same place the command palette gets them).

### 2. Error handling

Wrap the `getIssueDetail` calls in try/catch. On auth failure (401/token error):

```typescript
useToastStore.getState().addToast({
  id: `linear-auth-error-${Date.now()}`,
  message: "Linear token expired",
  status: "error",
  detail: "Update your Linear API key to see issue details.",
  action: {
    label: "Open Settings",
    onClick: () => {
      // Navigate to settings/integrations
      // Use whatever mechanism the app uses to open settings
    },
  },
});
```

Fall back to showing only cached data (identifier + title) without live details.

### 3. Context menu for unlinking

Use a simple context menu (can be a native Electron context menu via IPC, or a custom React context menu matching existing patterns in the app).

On "Unlink issue":
```typescript
await window.electronAPI.linear.unlinkIssueFromWorkspace(projectId, workspacePath, issueId);
```

The project store should update reactively (from the project-changed event), causing the popover and status bar to re-render. If the last issue is unlinked, the popover closes and the Linear section disappears from the status bar.

### 4. Wire into StatusBar

In `StatusBar.tsx`:
- Add a ref to the Linear section button (`anchorRef`).
- Add open/close state for the popover.
- Render `<LinkedIssuesPopover>` when open, passing the anchor ref and issues.

### 5. Popover positioning

Anchor above the status bar (since the status bar is at the bottom). Use a portal to render outside the status bar's DOM hierarchy. Position calculation: anchor rect top - popover height, aligned to the left edge of the anchor.

### 6. Styling

- Match the existing PR popover aesthetic from the sidebar.
- Max height with scroll for many issues.
- Smooth transition between list and detail views.
- Issue status badges should use colors consistent with Linear's status colors if possible (or neutral).

## Files to touch
- `src/components/LinkedIssuesPopover.tsx` — new component
- `src/components/LinkedIssuesPopover.module.css` — new styles
- `src/components/StatusBar.tsx` — wire popover to Linear section click
- `src/components/StatusBar.module.css` — minor adjustments for popover anchor
