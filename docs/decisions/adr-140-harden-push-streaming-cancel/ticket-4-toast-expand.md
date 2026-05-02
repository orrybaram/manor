---
title: Add expand-on-click to ToastItem with auto-expand and scroll cap
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Ticket 4: ToastItem expand UX

Extend `ToastItem` so a toast's `detail` can be collapsed to one truncated line by default and expanded to a scrollable multi-line view on click. Used by the push toast (ticket 5) but kept generic — no push-specific code here.

## Files to touch

- `src/store/toast-store.ts`
  - Extend the `Toast` type with one optional field:
    ```ts
    /** When true, render `detail` expanded on first mount instead of collapsed. */
    autoExpand?: boolean;
    ```
  - No change to actions — the store stays purely declarative; expand state itself is local to `ToastItem`.

- `src/components/ui/Toast/ToastItem.tsx`
  - Add local state `const [expanded, setExpanded] = useState(toast.autoExpand ?? false)`.
  - Wrap the `detail` div so it renders differently based on `expanded`:
    - Collapsed: single line, `text-overflow: ellipsis`, `white-space: nowrap`, `overflow: hidden`.
    - Expanded: `white-space: pre-wrap`, `max-height: 300px`, `overflow-y: auto`, monospace font.
  - Make the `<div className={styles.body}>` clickable when `detail` is present and contains a newline OR is longer than ~80 chars (i.e. expansion would actually reveal more): on click, `setExpanded(e => !e)`. Use `cursor: pointer` only when expandable. Ignore clicks if there's no detail.
  - When expanded, render a small caret/chevron indicator (use existing icon library — search for `lucide-react` imports in this folder).
  - Do NOT auto-collapse when `toast.status` flips (e.g. loading → error). User-driven only.

- `src/components/ui/Toast/Toast.module.css`
  - Add classes for `detailCollapsed`, `detailExpanded`, `detailExpandable` (cursor cue), and any chevron sizing.
  - Match existing toast typography. Detail text in expanded mode should use a monospace font so wrapped stderr is readable; check if the project has a CSS variable for monospace (e.g. `var(--font-mono)`) and use it, otherwise `font-family: ui-monospace, SFMono-Regular, Menlo, monospace`.

- Test (optional but encouraged): if there's an existing toast test file, add a render test for collapsed vs expanded; if not, skip — UI is thin and ticket 6 covers integration.

## Notes

- Keep this generic. No push-specific logic in `ToastItem`.
- The `autoExpand` flag is the single hook ticket 5 uses to surface error toasts pre-expanded.
- Don't add an explicit "expand button" — the whole body is the click target. Simpler and less visual noise.
- Clicking the optional `action` button must NOT toggle expand. Stop propagation on the action button's click handler.
