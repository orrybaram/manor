---
title: Make status bar icon source-aware for linked issues
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Make status bar icon source-aware for linked issues

Update the status bar to show the correct icon (Linear or GitHub) based on the linked issue source.

## Implementation

### Source detection

Add a helper to determine issue source from the `id` field:
```typescript
function isGitHubIssue(issue: LinkedIssue): boolean {
  return issue.id.startsWith("gh-");
}
```

### Status bar changes

Currently the status bar always shows `<LinearIcon>`. Update the icon logic:

- If all linked issues are GitHub → show `<GitHubIcon>`
- If all linked issues are Linear → show `<LinearIcon>`
- If mixed → show both icons or a generic link icon

The identifier display already works — GitHub issues use `#123` format, Linear uses `ENG-123`.

## Files to touch
- `src/components/StatusBar.tsx` — add source detection, conditionally render LinearIcon or GitHubIcon
- `src/components/CommandPalette/GitHubIcon.tsx` — import the existing GitHub icon component
