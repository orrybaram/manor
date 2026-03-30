---
title: Show linked issues in the status bar
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Show linked issues in the status bar

Add a Linear issues section to the status bar that shows the linked ticket identifier(s) for the active workspace.

## Implementation

### 1. Read linked issues from store

In `StatusBar.tsx`, the active workspace is already resolved. Read `linkedIssues` from it:

```typescript
const linkedIssues = workspace?.linkedIssues ?? [];
```

### 2. Render Linear section

After the workspace label and before the right section, add a clickable Linear section:

```tsx
{linkedIssues.length > 0 && (
  <button className={styles.linearSection} onClick={handleLinearClick}>
    <LinearIcon size={12} />
    <span>
      {linkedIssues.length === 1
        ? linkedIssues[0].identifier
        : `${linkedIssues.length} issues`}
    </span>
  </button>
)}
```

Import `LinearIcon` from `CommandPalette/LinearIcon.tsx`.

### 3. Style the Linear section

In `StatusBar.module.css`, add styles for `.linearSection`:
- Inline-flex, centered, small gap between icon and text.
- Match the existing segment styling (font size, color, padding).
- Cursor pointer, subtle hover state.
- Add a separator (like the existing `>`) between the workspace label and the Linear section.

### 4. Click handler (placeholder for ticket 4)

For now, `handleLinearClick` can be a no-op or log. The popover is wired in ticket 4.

## Files to touch
- `src/components/StatusBar.tsx` — add Linear section rendering and click state
- `src/components/StatusBar.module.css` — add `.linearSection` styles
