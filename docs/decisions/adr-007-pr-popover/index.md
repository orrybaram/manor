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

# ADR-007: PR Status Popover on Sidebar Badge

## Context

The sidebar currently shows a small PR badge (number + icon) next to each workspace's branch. Hovering only shows a native browser `title` tooltip with the PR title. Users want richer information on hover — PR status, CI check results, and review/approval status — without leaving the app.

The app already uses Radix UI primitives (Dialog, ContextMenu) and has `@radix-ui/react-popover` installed. The GitHub integration currently only fetches `number`, `state`, `title`, and `url` via `gh pr list`.

## Decision

### 1. Expand GitHub data model

Extend the `gh` CLI query to also fetch `statusCheckRollup`, `reviewDecision`, `isDraft`, `additions`, and `deletions`. Add a new method `getPrDetailForBranch` that fetches this extended data via `gh pr view`.

Update `PrInfo` interface to include:
- `isDraft: boolean`
- `additions: number`
- `deletions: number`
- `reviewDecision: string | null` — `"APPROVED"`, `"CHANGES_REQUESTED"`, `"REVIEW_REQUIRED"`, or `null`
- `checks: { total: number; passing: number; failing: number; pending: number }` — summarized from `statusCheckRollup`

### 2. Add Radix Popover to PR badge

Wrap the existing PR badge `<span>` in a `<Popover.Root>` / `<Popover.Trigger>` with hover-open behavior (using `onOpenChange` + mouse events). The `<Popover.Content>` renders a compact card showing:

- **PR title** and number
- **Status line**: open/merged/closed + draft indicator
- **CI checks**: icon + "3/3 passing" or "1 failing" summary
- **Review status**: approved/changes requested/review required icon + label
- **Diff stats**: +additions / -deletions
- **"Open in GitHub" link** at the bottom

### 3. Styling

Use CSS modules (add to `Sidebar.module.css`) matching the existing dark theme with `var(--surface)`, `var(--border)`, etc. The popover should be compact (~220px wide), positioned to the right of the badge.

## Consequences

- **Better**: Users get at-a-glance PR health without leaving the app
- **Better**: No extra polling — extended data is fetched in the same PR poll cycle
- **Tradeoff**: Slightly more data fetched per poll cycle (more `gh` fields), but negligible since it's the same single CLI call
- **Risk**: `statusCheckRollup` may be empty for repos without CI — handle gracefully with "No checks" state

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
