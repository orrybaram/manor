---
title: Add issue detail subview to command palette
status: done
priority: high
assignee: opus
blocked_by: [1]
---

# Add issue detail subview to command palette

Replace the current popover-based issue interaction with a drill-in detail view.

## Changes

### 1. Add `"issue-detail"` to `PaletteView` type

```typescript
type PaletteView = "root" | "linear" | "issue-detail";
```

### 2. Add state for selected issue

Replace `popoverIssue` state with:
```typescript
const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
```

### 3. Fetch issue detail with react-query

```typescript
const { data: issueDetail, isLoading: issueDetailLoading } = useQuery({
  queryKey: ["linear-issue-detail", selectedIssueId],
  queryFn: () => window.electronAPI.linearGetIssueDetail(selectedIssueId!),
  enabled: view === "issue-detail" && selectedIssueId !== null,
  staleTime: 60_000, // cache for 1 minute
});
```

### 4. Update issue list item behavior

When selecting an issue in the "linear" view:
- Set `selectedIssueId` to the issue's ID
- Navigate to `"issue-detail"` view
- Remove all `Popover.Root` / `Popover.Anchor` / `Popover.Portal` / `Popover.Content` wrappers from the linear issue list items

### 5. Render the detail view

When `view === "issue-detail"`:

**Breadcrumb**: Show "Linear Issues > {issue.identifier}" with back button that returns to "linear" view.

**Content** (scrollable area, not using cmdk Command.List):
- **Header**: Identifier + title
- **Metadata row**: Priority indicator (colored dot or label like "Urgent", "High", "Medium", "Low", "None"), state badge, labels (colored pills)
- **Assignee**: Name display
- **Description**: Rendered as plain text (strip markdown, truncate at ~500 chars with "..." if longer). Use a simple regex strip — no need for a markdown parser.
- **Actions** (pinned at bottom of the view, styled like the current popover actions but full-width):
  - Create Workspace (GitBranch icon)
  - Open in Browser (ExternalLink icon)

### 6. Update escape/back navigation

- Escape from `"issue-detail"` → back to `"linear"` (not root)
- Back button in breadcrumb → back to `"linear"`
- Reset `selectedIssueId` when navigating back

### 7. Clean up popover imports and code

Remove `Popover` import from `@radix-ui/react-popover` and all popover-related refs (`popoverAnchorRef`, `popoverIssue`). Remove `popoverAction`, `issuePopover` CSS classes aren't needed anymore — but repurpose/rename them for the detail view action buttons.

## Files to touch
- `src/components/CommandPalette.tsx` — main implementation: new view, remove popover, add detail rendering
- `src/components/CommandPalette.module.css` — styles for detail view (header, metadata, description, actions)
