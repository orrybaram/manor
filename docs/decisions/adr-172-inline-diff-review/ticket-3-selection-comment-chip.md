---
title: Floating "Comment" chip on diff text selection
status: done
priority: high
assignee: opus
blocked_by: [1, 2]
---

# Floating "Comment" chip on diff text selection

The entry point: select lines in a diff, get a chip, click it, get a composer.

## 1. `SelectionCommentChip` (new component dir)

`src/components/workspace-panes/DiffPane/SelectionCommentChip/SelectionCommentChip.tsx`
plus a `.module.css`.

```ts
type SelectionCommentChipProps = {
  /** The DiffPane scroll container — selections outside it are ignored. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  onComment: (anchor: SelectionAnchor) => void;
};
```

Behaviour:

- Listens for `selectionchange` on `document`, **debounced** with
  `requestAnimationFrame` (it fires on every mouse move during a drag).
- Ignores the selection unless: it is non-collapsed, `containerRef.current`
  contains `sel.anchorNode`, and `selectionToAnchor(sel)` (ticket 1) returns
  non-null.
- Also listens for `mouseup` and `keyup` on the container, because
  `selectionchange` does not fire when a drag ends on an unchanged selection.
- Position: `sel.getRangeAt(0).getBoundingClientRect()`. Render **fixed**, into
  a `createPortal(…, document.body)` so it is not clipped by the diff's
  `contain: layout paint` or `overflow: auto`. Place it 6px below the
  selection's bottom edge, left-aligned to the selection's left edge, clamped
  to the viewport with an 8px margin; flip above the selection when there is
  less than 44px of room below.
- Content: one `<Button variant="secondary" size="sm">` with a
  `MessageSquarePlus` icon (size 12) and the label "Comment". Wrap in
  `Tooltip` showing the anchor label (e.g. "Comment on L12–L18").
- `onMouseDown={(e) => e.preventDefault()}` on the chip so clicking it does not
  clear the selection before `onClick` runs.
- Hides itself on: scroll of the container, Escape, and after `onComment` fires.
- Never renders when the pane has no `workspacePath` (a diff with nowhere to
  send a review has no business offering one).

Which file the selection is in is resolved by the **caller**, not the chip —
see below.

## 2. Wire into `DiffPane`

`DiffPane.tsx` already has `containerRef` and `fileRefs`. Add:

```tsx
{workspacePath && (
  <SelectionCommentChip
    containerRef={containerRef}
    onComment={handleStartComment}
  />
)}
```

`handleStartComment(anchor)`:

1. Resolve the file. Walk up from the selection's `[data-diff-lines]` container
   to the nearest ancestor that is a value in `fileRefs.current` — simplest
   robust way is to give the per-file wrapper a `data-file-path={file.path}`
   attribute (it is the `div` inside `ContextMenu.Trigger`) and read
   `closest("[data-file-path]")?.dataset.filePath`. Bail if absent.
2. `const id = useReviewStore.getState().addDraft(workspacePath, { filePath, ...anchor, body: "" })`
3. `setEditingId(id)`
4. `window.getSelection()?.removeAllRanges()` — the selection has served its
   purpose and leaving it highlighted behind the composer is noisy.
5. Make sure the file is not collapsed (`setCollapsed` minus this path), so the
   new card is actually visible.

## 3. Replace the inline `onCopy` logic

`DiffPane.tsx`'s `onCopy` prop currently contains its own copy of the
selection-walking code. Replace its body with `selectionSnippet(sel)` from
ticket 1, keeping the existing `${file.path}\n${body}` clipboard format and the
`sel.toString()` fallback when no rows are matched. Behaviour must not change;
this is de-duplication.

## 4. Add the context-menu entry

The file's existing `ContextMenu.Content` gets a "Comment on selection" item
above "Copy", enabled only when `savedSelection.current` is non-empty. It runs
the same `handleStartComment` path. `savedSelection` currently stores a string;
widen it to also stash the resolved `SelectionAnchor` captured in
`onOpenChange` (the context menu opening clears nothing, but the anchor must be
captured before the menu steals focus).

## Files to touch
- `src/components/workspace-panes/DiffPane/SelectionCommentChip/SelectionCommentChip.tsx` — new
- `src/components/workspace-panes/DiffPane/SelectionCommentChip/SelectionCommentChip.module.css` — new
- `src/components/workspace-panes/DiffPane/DiffPane.tsx` — mount the chip, `handleStartComment`, `data-file-path`, `onCopy` de-dup, context-menu item
