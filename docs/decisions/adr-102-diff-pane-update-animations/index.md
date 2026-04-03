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

# ADR-102: Subtle animations for DiffPane updates

## Context

The DiffPane polls for diff changes every 5 seconds. When files change, get added, or are removed, the UI updates instantly with no visual indication of what changed. Users have no way to tell which file blocks are new or which have been modified since the last poll.

## Decision

Add CSS-based animations to the DiffPane to subtly indicate updates:

1. **New file blocks**: When a new file appears in the diff, animate it in with a fade + slight slide-down. Use a CSS `@keyframes` animation applied via a class that gets added when a file is first seen.

2. **Updated file blocks**: When an existing file's diff content changes (line count or content hash differs), flash a subtle highlight on the file header to draw attention. A brief background-color pulse that fades out.

3. **File list items**: Mirror the same animations for the file list at the top — new entries fade in, updated entries get a brief highlight pulse.

**Implementation approach:**

- Track previous file paths and a content hash (e.g. `added + removed + lines.length`) in a `useRef` to detect new vs updated files across re-renders.
- Apply CSS animation classes conditionally. Use `animationend` or a timeout to remove the "updated" highlight class after the animation completes.
- All animations via CSS `@keyframes` in the CSS module — no JS animation libraries.
- Keep animations subtle and short (200-400ms) to avoid being distracting.

**Files:**
- `src/components/workspace-panes/DiffPane/DiffPane.module.css` — add keyframes and animation classes
- `src/components/workspace-panes/DiffPane/DiffPane.tsx` — track file state changes, apply animation classes

## Consequences

- **Better**: Users get visual feedback when the diff updates, making it easier to spot changes during active development.
- **Neutral**: Small amount of additional state tracking (previous file hashes in a ref), negligible performance impact.
- **Risk**: Animations could feel annoying if too prominent — keeping them subtle (low opacity, short duration) mitigates this.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
