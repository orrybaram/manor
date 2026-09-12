---
title: DiffCommentCard, rendered inside virtualized diff rows
status: done
priority: critical
assignee: opus
blocked_by: [1]
---

# DiffCommentCard, rendered inside virtualized diff rows

The inline half of the feature: a comment composer/read-view that lives in the
diff, anchored to the lines it is about.

## 1. `DiffCommentCard` (new component dir)

`src/components/workspace-panes/DiffPane/DiffCommentCard/DiffCommentCard.tsx`
plus a `.module.css`, matching the layout of the other `DiffPane` subcomponents
(`FileHeader/`, `SearchBar/`).

```ts
type DiffCommentCardProps = {
  comment: DraftComment;
  editing: boolean;
  onSave: (body: string) => void;
  onCancel: () => void;      // discards an empty new draft; reverts an edit
  onEdit: () => void;
  onDelete: () => void;
};
```

**Editing state** — a Claude-Desktop-style composer:

- A rounded surface: `background: var(--surface)`, `1px solid var(--border)`,
  `border-radius: 8px`, sitting in the content column (left-inset so it clears
  the 50px line-number gutter) with ~6px of vertical breathing room.
- A header line: the file-relative anchor label (`comment.startLabel`) in
  `--text-dim`, 11px.
- An auto-growing `<textarea>` — reset `height` to `auto` then set it to
  `scrollHeight` on every input, min 3 rows, max ~12 rows then scroll.
  Placeholder "Leave a comment…". Inherits the app's UI font, **not** the diff's
  mono font. Autofocus when the card mounts in editing state.
- Footer `Row`: `<Button variant="ghost" size="sm">Cancel</Button>` and
  `<Button variant="primary" size="sm" disabled={!body.trim()}>Add comment</Button>`.
- Keys: ⌘/Ctrl+Enter saves, Escape cancels. Both `stopPropagation` so the diff
  pane's ⌘F handler and any global Escape handling do not also fire.

**Read state** — the saved comment as an annotation:

- Same surface, tighter padding, body rendered as plain text with
  `white-space: pre-wrap`.
- A small header row: `startLabel`, and on hover of the card, ghost `Edit` and
  `Delete` buttons (`Pencil` / `Trash2` from `lucide-react/dist/esm/icons/*`,
  size 12) right-aligned. Hidden via opacity so the row does not reflow on
  hover.

Use `Button` from `ui/Button/Button` everywhere — no raw `<button>` (project
rule). Use `Tooltip` from `ui/Tooltip/Tooltip` for the Edit/Delete icon
buttons.

## 2. `DiffLines` renders anchored comments

`src/components/workspace-panes/DiffPane/DiffLines/DiffLines.tsx` gains:

```ts
comments?: DraftComment[];        // drafts for THIS file only
editingId?: string | null;
onSaveComment?: (id: string, body: string) => void;
onCancelComment?: (id: string) => void;
onEditComment?: (id: string) => void;
onDeleteComment?: (id: string) => void;
```

Inside the component:

- `const commentsByEnd = useMemo(...)` → `Map<number, DraftComment[]>` keyed by
  `endIndex`, and a `commentedIndices: Set<number>` covering every
  `startIndex..endIndex` span. Both memoized on `comments`.
- In the row renderer, after the existing `<div className={numClass}>` /
  `<div className={contentClass}>` pair, render
  `commentsByEnd.get(i)?.map(c => <DiffCommentCard … />)`. The cards go **inside
  the same row `<div>`** that already carries `ref={measureRef}` and
  `data-index={i}` — that is what makes the virtualizer measure the taller row.
  The row currently uses `display: flex` on a horizontal axis; wrap the
  number-cell + content-cell pair in an inner flex row and make the outer row
  `flex-direction: column` **only when it has comments** (add a `.rowWithComment`
  class), so the cards stack under the code instead of beside it.
- Rows in `commentedIndices` get `data-commented="true"`; style it in
  `DiffLines.module.css` as a 2px left accent (`box-shadow: inset 2px 0 0
  var(--blue)` on the line-number cell) plus a faint
  `color-mix(in srgb, var(--blue) 6%, transparent)` wash on the content cell —
  enough to say "there is a note on this" without fighting the add/del tints.

**Virtualizer note for the implementer:** do not change `estimateSize` or
`overscan`. `measureElement` already reports the real `offsetHeight` of each
row, so a row that grows by a card's height is handled. Do check that mounting
a card does not fight `contain: layout paint` on `.scrollContainer` — if the
card needs to overflow the container horizontally it will be clipped, so keep
it inside the content column.

## 3. Wire the props through `DiffPane` (minimal)

In `DiffPane.tsx`, group drafts by file once:

```ts
const drafts = useReviewStore((s) => (workspacePath ? s.drafts[workspacePath] ?? NO_DRAFTS : NO_DRAFTS));
const draftsByFile = useMemo(() => { /* Map<string, DraftComment[]> */ }, [drafts]);
```

Add `const [editingId, setEditingId] = useState<string | null>(null)` and pass
`comments={draftsByFile.get(file.path)}`, `editingId`, and handlers bound to
the store (`updateDraft` + clear editing on save; `removeDraft` on cancel of an
empty draft, clear editing otherwise; `removeDraft` on delete) into each
`<DiffLines>`.

A draft whose `endIndex >= file.lines.length` is filtered out of
`commentsByEnd` rather than rendered — the ADR accepts anchor drift, and a card
must never be rendered against a row that does not exist.

Creating drafts is ticket 3's job; this ticket only needs a draft that already
exists in the store to render, be editable, and be deletable.

## Files to touch
- `src/components/workspace-panes/DiffPane/DiffCommentCard/DiffCommentCard.tsx` — new
- `src/components/workspace-panes/DiffPane/DiffCommentCard/DiffCommentCard.module.css` — new
- `src/components/workspace-panes/DiffPane/DiffLines/DiffLines.tsx` — render anchored cards inside measured rows
- `src/components/workspace-panes/DiffPane/DiffLines/DiffLines.module.css` — `.rowWithComment`, `[data-commented]` accent
- `src/components/workspace-panes/DiffPane/DiffPane.tsx` — group drafts by file, own `editingId`, pass handlers down
