---
title: In phone mode a split stacks its children, and nothing remounts
status: in-progress
priority: critical
assignee: opus
blocked_by: [1]
---

# In phone mode a split stacks its children, and nothing remounts

ADR-181 D1 — the core of this ADR. Read its Context section on "the invariant
a phone layout must not break" before touching anything.

## The rule

In phone mode, `SplitPanelLayout` (panels) and `SplitLayout` (panes) keep
their **element structure and child order exactly** and change only how they
lay their two children out: instead of a flex split with a ratio and a drag
divider, each child is a `tab-styles` layer (`TAB_VISIBLE_STYLE` /
`TAB_HIDDEN_STYLE` from `src/lib/tab-styles.ts`) over the full box.

The visible child is the one that **contains the viewport's focus**:

- `SplitPanelLayout`: the child subtree containing this workspace's active
  panel (`selectActivePanelId` / `useActivePanel`).
- `SplitLayout`: the child subtree containing the focused pane of the tab it
  belongs to (the viewport's `focusedPaneIds[tabId]`, falling back to the
  tab's first pane when none is set — the same fallback the desk uses).

Add small pure helpers next to the trees — `panelTreeContains(node, panelId)`
and `paneTreeContains(node, paneId)` — in `src/lib/layout/panel-tree.ts` and
`pane-tree.ts`, with tests. `allPaneIds` already exists and is fine to build
on.

Recursively this makes only the path to the focused leaf visible, and puts
every pane of the workspace in **the same box**. The visible layer must use
`visibility: inherit` (that is what `TAB_VISIBLE_STYLE` does) so a visible
child inside a hidden workspace or tab does not paint itself back in — the
comment at the top of `tab-styles.ts` explains why.

In phone mode: no divider element, no `onMouseDown` resize handling. In desk
mode: **no behavioural change at all.**

## Why structure, not just CSS

A terminal remount is a `pty.detach` and a `pty.create`, a snapshot restore,
and — for a pane this renderer owns the winsize of — a PTY resize. React keeps
a component's state only if its position in the tree and its type are the
same between renders. So both modes must render the same element types at the
same positions with the same keys; only `style`/`className` differs. Do not
return a different wrapper element in phone mode.

## Tests

- Unit (Vitest + Testing Library): render a two-level split of panes in phone
  mode; assert exactly one leaf is visible and it is the focused one; change
  focus and assert the visible leaf moves.
- **Identity**: mount a `LeafPane` stub that counts mounts; switch focus
  between panes in phone mode, and flip the mode itself; assert mount count
  never increases. This is the test that makes D1 true rather than
  aspirational — do not skip it.
- Desk mode renders byte-for-byte what it did before (snapshot or structural
  assertion on an existing split).

## Files to touch
- `src/components/panels/SplitPanelLayout.tsx`
- `src/components/workspace-panes/SplitLayout.tsx`
- `src/lib/layout/panel-tree.ts`, `src/lib/layout/pane-tree.ts` — the `…Contains` helpers
- their `__tests__` — new cases
