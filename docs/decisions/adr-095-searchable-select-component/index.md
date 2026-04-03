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

# ADR-095: Extract SearchableSelect UI Component

## Context

The `NewWorkspaceDialog` has a hand-rolled combobox for the "Base branch" picker. It uses a raw `<Input>` with a CSS-positioned dropdown, manual keyboard navigation, and a `setTimeout` blur hack. This pattern:

1. Lacks proper ARIA attributes (`role="combobox"`, `aria-expanded`, `aria-activedescendant`, `listbox`)
2. Uses CSS absolute positioning that breaks in scroll containers or near viewport edges
3. Is not reusable — the next feature that needs a searchable dropdown will copy-paste this code
4. The trigger should be a compact button (branch icon + truncated name, max-width 250px) rather than a full-width input

The app already has `@radix-ui/react-popover` installed and uses it in `PrPopover`, `TabBar`, `LinearProjectSection`, and `LinkedIssuesPopover`.

## Decision

Create a new `SearchableSelect` component at `src/components/ui/SearchableSelect/` built on `@radix-ui/react-popover`. The component:

- **Trigger**: A `<Button>` (secondary variant, sm size) showing an optional icon + the selected value label, truncated with `text-overflow: ellipsis` at `max-width: 250px`. Uses `Popover.Trigger asChild`.
- **Content**: A `Popover.Content` panel containing:
  - A search `<Input>` at the top (auto-focused on open)
  - A scrollable `listbox` of options filtered by the search term
  - Loading state (spinner + message)
  - Empty state ("No matching items")
- **Keyboard**: Arrow up/down to navigate, Enter to select, Escape to close. `aria-activedescendant` tracks the highlighted option.
- **ARIA**: `role="combobox"` on trigger, `role="listbox"` on the list, `role="option"` on each item, `aria-expanded`, `aria-controls`, `aria-activedescendant`.

**API**:
```tsx
<SearchableSelect
  value={baseBranch}
  onChange={setBaseBranch}
  options={allBranchOptions}
  loading={loadingBranches}
  placeholder="Search branches..."
  emptyMessage="No matching branches"
  icon={<GitBranch size={12} />}
/>
```

Props:
- `value: string` — currently selected value
- `onChange: (value: string) => void`
- `options: string[]` — flat list of options
- `loading?: boolean` — shows spinner in dropdown
- `placeholder?: string` — search input placeholder
- `emptyMessage?: string` — shown when filter yields no results
- `icon?: ReactNode` — icon shown in trigger button before the value
- `maxWidth?: number` — trigger max-width (default 250)
- `disabled?: boolean`

Then refactor `NewWorkspaceDialog` to consume `SearchableSelect` instead of the inline combobox, removing all the hand-rolled dropdown state (`showDropdown`, `highlightIndex`, `branchRef`, `handleBranchKeyDown`, `selectBranchOption`, `comboboxWrapper` styles).

## Consequences

- **Better**: Reusable searchable dropdown for future features. Proper a11y. Correct popover positioning via Radix.
- **Better**: ~80 lines of inline state/handlers removed from NewWorkspaceDialog.
- **Tradeoff**: New component to maintain. Acceptable given it replaces ad-hoc code that would have been duplicated.
- **Risk**: Radix Popover focus management may conflict with Dialog focus trapping. The `onOpenAutoFocus` handler on the Popover content should handle this, and PrPopover already demonstrates this works inside complex focus contexts.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
