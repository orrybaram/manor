---
title: Tab bars on the frame and rounded panel bodies
status: todo
priority: high
assignee: opus
blocked_by: [1]
---

# Tab bars on the frame and rounded panel bodies

Read ADR-196 (`docs/decisions/adr-196-window-frame-inset-panels/index.md`) sections 3 and 4. Ticket 1 already added `--frame-gap`, `--window-lead-inset`, `topLeftPanelId` and the frame background.

## Steps

1. **TabBar** (`TabBar.tsx`, `TabBar.module.css`):
   - Remove the `sidebarMode` read and the `.noSidebar` / `.railSidebar` classes.
   - `.tabBar`: transparent background, height 40px, tabs bottom-aligned, no 12px top padding. Keep the drop-target and split-hint states visible on the frame (tint with `color-mix` over `var(--bg-deep)` instead of `var(--dim)`).
   - Top-left only: compute `topLeftPanelId(panelTree) === panelId` from the workspace layout in app-store and apply `padding-left: var(--window-lead-inset)`. Other panels get `padding-left: 8px`.
   - Active tab: keep `var(--surface)`, add top/side `1px solid var(--border)` and `margin-bottom: -1px` + `position: relative; z-index: 1` so it covers the panel body's top border.
2. **LeafPanel** (`LeafPanel.tsx`, `PanelLayout.module.css`): style the `.terminal-container` below the tab bar as the panel body: `var(--bg)` background, `1px solid var(--border)`, `border-radius: 8px`, `overflow: hidden`. Use a module class on it rather than changing the global `.terminal-container` rule, which other surfaces share. Keep `data-focus-region="pane"`.
3. **Panel splits** (`SplitPanelLayout.tsx`): give it its own CSS module instead of importing `PaneLayout.module.css`. Divider is `var(--frame-gap)` wide/tall, transparent, `var(--accent)` on hover and while dragging (keep the existing resize logic). Pane splits inside a tab (`PaneLayout`) keep their 3px divider.
4. **Main content edges** (`App.css`): `.main-content` gets `var(--frame-gap)` right padding; the left edge needs `var(--frame-gap)` only in `rail` mode (the sidebar panel's right gutter covers `full`, and `hidden` should also get it). Keep the `workspace-stack` geometry identical for active and inactive workspaces (see the comment in `App.tsx` about PTY resizes).
5. **Empty surface**: `.drag-region` inside `.empty-surface` becomes 40px; `.empty-surface > .terminal-container` gets the panel body styling.
6. **StatusBar** (`StatusBar.module.css`): transparent background, no top border.
7. **DetachedApp**: check that popout windows look right with the transparent tab bar (the `:root` default `--window-lead-inset: 78px` applies there) and that the splash `.drag-region` still works.
8. Run the app if possible and check: full / rail / hidden modes, a horizontal and a vertical panel split, home screen, projects overview, a detached window, and a light theme.

## Files to touch
- `src/components/tabbar/TabBar/TabBar.tsx`, `TabBar.module.css` — transparent bar, top-left inset, merged active tab
- `src/components/panels/LeafPanel.tsx`, `PanelLayout.module.css` — rounded panel body
- `src/components/panels/SplitPanelLayout.tsx` + new `SplitPanelLayout.module.css` — gutter divider
- `src/App.css` — `.main-content` padding, empty-surface drag region and panel body
- `src/components/statusbar/StatusBar/StatusBar.module.css` — on-frame status bar
- `src/DetachedApp.tsx` — only if the check in step 7 needs a change
- `src/components/tabbar/__tests__/*` — update any test that asserts the removed classes
