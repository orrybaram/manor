---
title: Add context menu and multiselect to FileList
status: done
priority: high
assignee: opus
blocked_by: [1]
---

# Add context menu and multiselect to FileList

Add a Radix context menu to file list items and multiselect support for batch git operations in local mode.

## Implementation

### `FileList.tsx` — Major update

**New props:**
```typescript
type FileListProps = {
  files: DiffFile[];
  onSelectFile: (path: string) => void;
  animationState: Map<string, "new" | "updated">;
  diffMode: DiffMode;
  workspacePath?: string;
  selectedFiles: Set<string>;
  onSelectionChange: (selected: Set<string>) => void;
};
```

**Selection behavior:**
- Regular click: select single file + scroll to it (existing behavior via `onSelectFile`)
- Cmd/Ctrl+Click: toggle file in selection
- Shift+Click: range select from last clicked file to current
- Track `lastClickedIndex` with useRef

**Context menu (Radix `@radix-ui/react-context-menu`):**
- On right-click: if the file isn't in selection, select just that file; if it is, keep current selection
- Menu items:
  - "Open in Editor" — calls `window.electronAPI.shell.openInEditor` for each selected file
  - Separator (only in local mode)
  - "Stage" — calls `window.electronAPI.git.stage(wsPath, [...selectedFiles])` (local mode only)
  - "Unstage" — calls `window.electronAPI.git.unstage(wsPath, [...selectedFiles])` (local mode only)
  - "Stash" — calls `window.electronAPI.git.stash(wsPath, [...selectedFiles])` (local mode only)
  - Separator (local mode only)
  - "Discard" — styled destructive with red text, opens a confirm modal before executing (local mode only)

**Confirmation modal for destructive actions (Discard and Stash):**
- Use `@radix-ui/react-dialog` following the existing pattern from `DeleteWorktreeDialog.tsx` / `CloseAgentPaneDialog.tsx`
- Uses existing `confirmOverlay`, `confirmDialog`, `confirmTitle`, `confirmDescription`, `confirmActions` CSS classes from the Sidebar styles — create equivalent styles in `FileList.module.css` following the same pattern
- Use the `Button` component (`../../../ui/Button/Button`) with `variant="danger"` for the confirm button
- Modal lists the exact files that will be affected (show each file path)
- Title: "Discard Changes" / "Stash Files"
- Description: "This will permanently discard changes to the following files:" / "The following files will be stashed:"
- File list displayed as `<code>` blocks
- Two buttons: "Cancel" (secondary) and "Discard" / "Stash" (danger)
- Managed via `useState` in FileList: `confirmAction: null | { type: "discard" | "stash"; files: string[] }`

**Visual indicators:**
- Selected files get a `selected` CSS class with subtle background highlight
- In local mode, show a checkbox on each row
- Header shows "N selected" when files are selected

**Keyboard:** Escape clears selection.

### `FileList.module.css` — Add styles

```css
.fileListItemSelected {
  background: color-mix(in srgb, var(--accent, var(--blue)) 15%, transparent);
}

.checkbox {
  width: 14px;
  height: 14px;
  accent-color: var(--accent, var(--blue));
  margin-right: 8px;
  flex-shrink: 0;
}

/* Context menu — same pattern as DiffPane.module.css */
.contextMenu {
  background: var(--surface);
  border: 1px solid var(--text-dim);
  border-radius: 8px;
  padding: 4px;
  min-width: 180px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  z-index: 50;
}

.contextMenuItem {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  font-size: 12px;
  border-radius: 4px;
  cursor: pointer;
  outline: none;
}

.contextMenuItem:hover,
.contextMenuItem[data-highlighted] {
  background: var(--accent);
  color: var(--text-selected);
  outline: none;
}

.contextMenuItemDestructive:hover,
.contextMenuItemDestructive[data-highlighted] {
  background: var(--red);
  color: var(--text-selected);
}

.contextMenuSeparator {
  height: 1px;
  margin: 4px 0;
  background: var(--border);
}

.selectionInfo {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-dim);
}

/* Confirm modal — matches Sidebar confirmDialog pattern */
.confirmOverlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 100;
}

.confirmDialog {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  min-width: 360px;
  max-width: 480px;
  max-height: 60vh;
  overflow-y: auto;
  z-index: 101;
}

.confirmTitle {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  margin: 0 0 8px;
}

.confirmDescription {
  font-size: 13px;
  color: var(--text-dim);
  margin: 0 0 12px;
}

.confirmFileList {
  list-style: none;
  padding: 0;
  margin: 0 0 16px;
}

.confirmFileList code {
  display: block;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--text-dim);
  padding: 2px 0;
}

.confirmActions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
```

### `DiffPane.tsx` — Wire up selection state and pass new props

Add state:
```typescript
const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
```

Clear selection when diffMode changes. Pass to FileList:
```tsx
<FileList
  files={files}
  onSelectFile={scrollToFile}
  animationState={animationState}
  diffMode={diffMode}
  workspacePath={workspacePath}
  selectedFiles={selectedFiles}
  onSelectionChange={setSelectedFiles}
/>
```

## Files to touch
- `src/components/workspace-panes/DiffPane/FileList/FileList.tsx` — add context menu, multiselect, git operations
- `src/components/workspace-panes/DiffPane/FileList/FileList.module.css` — add selection, context menu, destructive styles
- `src/components/workspace-panes/DiffPane/DiffPane.tsx` — add selectedFiles state, pass new props to FileList
