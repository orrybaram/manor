---
title: Refactor NewWorkspaceDialog to use SearchableSelect
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Refactor NewWorkspaceDialog to use SearchableSelect

Replace the hand-rolled branch combobox in `NewWorkspaceDialog` with the new `SearchableSelect` component.

## Changes

**Remove from NewWorkspaceDialog.tsx**:
- State: `showDropdown`, `highlightIndex`
- Ref: `branchRef`
- Callbacks: `selectBranchOption`, `handleBranchKeyDown`
- The entire `<div className={styles.comboboxWrapper}>` block (lines 252-302)
- The `filteredBranches` computed value (filtering is now internal to SearchableSelect)

**Add**:
- Import `SearchableSelect` from `../../ui/SearchableSelect`
- Import `GitBranch` from `lucide-react`
- Replace the combobox block with:
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

**Remove from NewWorkspaceDialog.module.css**:
- `.comboboxWrapper`
- `.dropdown`
- `.dropdownItem`, `.dropdownItemHighlighted`
- `.dropdownMessage`

**Update `handleOpenAutoFocus`**: Remove lines that reset `showDropdown` and `highlightIndex`.

## Files to touch
- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx` — replace combobox with SearchableSelect
- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.module.css` — remove unused combobox styles
