---
type: adr
status: proposed
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

# ADR-103: FileList Context Menu and Multiselect Git Operations

## Context

The DiffPane's FileList currently only supports clicking a file to scroll to its diff. There's no context menu on file list items, and no way to perform git operations on files directly from the diff viewer. The diff view on individual files already has a context menu (copy, open in editor) via Radix `@radix-ui/react-context-menu`, but the file list sidebar lacks one.

In local changes mode, users need to stage, unstage, stash, and discard individual or multiple files without leaving the diff pane. This requires multiselect support in the FileList and new electron IPC handlers for git operations.

## Decision

### 1. New Electron IPC Handlers for Git Operations

Add a `git` namespace to the electron API with these operations:
- `git.stage(wsPath, files)` — `git add <files>`
- `git.unstage(wsPath, files)` — `git restore --staged <files>`
- `git.discard(wsPath, files)` — `git checkout -- <files>` (tracked) + `git clean -f <files>` (untracked)
- `git.stash(wsPath, files)` — `git stash push -- <files>`

All operations accept an array of file paths to support batch operations from multiselect.

### 2. FileList Context Menu

Add a Radix context menu to FileList items with:
- **Open in Editor** — always available (uses existing `shell.openInEditor`)
- **Separator**
- **Stage Files** / **Unstage Files** — only in local mode
- **Stash Files** — only in local mode
- **Separator**
- **Discard Files** — only in local mode, destructive action

The context menu reuses the existing `.contextMenu` styles from `DiffPane.module.css`. These styles will be extracted to a shared CSS file or imported from DiffPane.

### 3. Multiselect in FileList (Local Mode Only)

- Click selects a single file (and scrolls to it as before)
- Cmd/Ctrl+Click toggles a file in the selection
- Shift+Click selects a range
- Context menu on a selected file applies to all selected files
- Context menu on an unselected file selects just that file
- A checkbox appears on each file row in local mode to indicate selection state
- Header shows selection count and bulk action buttons (Stage All, Unstage All)

### 4. Component Structure

- `FileList.tsx` — gains `selectedFiles`, `onSelectionChange`, `diffMode`, `workspacePath` props
- New context menu styles added to `FileList.module.css` (reusing pattern from DiffPane)
- `DiffPane.tsx` — manages `selectedFiles` state, passes git operation callbacks

## Consequences

- **Better**: Users can perform common git operations directly from the diff view without switching to terminal
- **Better**: Multiselect enables batch operations, a significant productivity improvement
- **Tradeoff**: FileList component grows in complexity with selection state and context menu
- **Risk**: Discard is destructive — needs to be clearly marked (no confirmation dialog for now, but styled as destructive)

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
