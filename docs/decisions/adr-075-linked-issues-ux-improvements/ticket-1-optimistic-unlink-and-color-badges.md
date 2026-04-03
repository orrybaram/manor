---
title: Optimistic unlink and color-coded status badges
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# Optimistic unlink and color-coded status badges

Two changes to `LinkedIssuesPopover.tsx` and its CSS module.

## 1. Optimistic unlink

- Add `const [removedIds, setRemovedIds] = useState<Set<string>>(new Set())` to track optimistically removed issues
- In `handleUnlink`, add the issue ID to `removedIds` immediately before the API call
- Filter the `issues` array by `removedIds` when rendering the list
- After the API call resolves, call `useProjectStore.getState().loadProjects()` to sync the store
- If it was the last visible issue, close the popover

## 2. Color-coded status badges

- Create a helper function `getStatusColor(detail: IssueDetail | undefined)` that returns a `{ color: string; bg: string }` object:
  - Linear `state.type`:
    - `"started"` → `{ color: "var(--yellow)", bg: "var(--yellow-a20, rgba(249,226,175,0.13))" }`
    - `"completed"` → `{ color: "var(--green)", bg: "var(--green-a20, rgba(166,227,161,0.13))" }`
    - `"cancelled"` → `{ color: "var(--red)", bg: "var(--red-a20, rgba(238,85,85,0.13))" }`
    - default (backlog/unstarted/triage) → keep current gray: `{ color: "var(--text-dim)", bg: "var(--surface)" }`
  - GitHub `state`:
    - `"open"` → `{ color: "var(--green)", bg: "var(--green-a20, rgba(166,227,161,0.13))" }`
    - `"closed"` → `{ color: "var(--red)", bg: "var(--red-a20, rgba(238,85,85,0.13))" }`
    - default → gray
- Apply via inline `style` on the `.issueStatus` span in IssueRow

## Files to touch
- `src/components/LinkedIssuesPopover.tsx` — add removedIds state, update handleUnlink, add getStatusColor helper, apply inline styles
- `src/components/LinkedIssuesPopover.module.css` — no changes needed (inline styles override)
