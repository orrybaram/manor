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

# ADR-075: Linked Issues UX Improvements

## Context

When unlinking an issue from a workspace via the LinkedIssuesPopover, the issue remains visible in the UI until the next project store refresh. The `handleUnlink` function calls the electron API but doesn't optimistically remove the issue from the displayed list. Additionally, the status badges in the popover use a uniform gray style regardless of state (open/closed, started/completed, etc.), making it hard to quickly assess issue status.

## Decision

Two targeted changes to `LinkedIssuesPopover.tsx` and its CSS module:

1. **Optimistic unlink**: Track removed issue IDs in local state. Filter them out of the rendered list immediately on unlink, before the API call resolves. Call `loadProjects()` after the API call to sync the store.

2. **Color-coded status badges**: Map issue state types to colors using the existing CSS variable palette:
   - Linear states: use `state.type` field (`started` → yellow, `completed` → green, `cancelled` → red, `backlog`/`unstarted` → gray)
   - GitHub states: `open` → green, `closed` → red

## Consequences

- Users get instant visual feedback when unlinking — no stale UI.
- Status badges become scannable at a glance.
- No new dependencies; uses existing CSS custom properties.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
