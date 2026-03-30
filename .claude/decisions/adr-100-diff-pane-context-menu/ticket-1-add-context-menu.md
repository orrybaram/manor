---
title: Add context menu to DiffPane file blocks
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# Add context menu to DiffPane file blocks

Add a Radix UI context menu to each file block in the DiffPane with "Copy" and "Open in Editor" items.

## Implementation

1. Import `* as ContextMenu from "@radix-ui/react-context-menu"` and the `Clipboard` and `ExternalLink` icons from lucide-react.

2. In the `DiffPane` component, wrap each file's `<div className={styles.file}>` with `ContextMenu.Root > ContextMenu.Trigger(asChild)`, and add a `ContextMenu.Portal > ContextMenu.Content` with two items:

   - **Copy**: `navigator.clipboard.writeText(window.getSelection()?.toString() ?? "")`. The item text should just say "Copy".
   - **Open in Editor**: `window.electronAPI.shell.openInEditor(workspacePath + "/" + file.path)`. Construct the full path by joining `workspacePath` prop with the file's relative path. Only render this item when `workspacePath` is available.

3. Add context menu CSS classes to `DiffPane.module.css` matching the TerminalPane pattern:
   - `.contextMenu` — background, border, border-radius, padding, shadow, min-width, z-index
   - `.contextMenuItem` — flex row, gap, padding, font-size, border-radius, cursor, icon+text layout
   - `.contextMenuItem:hover` / `[data-highlighted]` — accent background, selected text color
   - `.contextMenuSeparator` — 1px divider

## Files to touch
- `src/components/workspace-panes/DiffPane/DiffPane.tsx` — add ContextMenu wrapper around file blocks, add Copy and Open in Editor items
- `src/components/workspace-panes/DiffPane/DiffPane.module.css` — add context menu styles
