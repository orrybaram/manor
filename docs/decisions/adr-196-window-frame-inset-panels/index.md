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

# ADR-196: Window frame with tabs in the title row and inset panels

## Context

On macOS the traffic lights sit at `trafficLightPosition: { x: 13, y: 13 }` (`electron/window.ts`) and run to about x=65. The collapsed rail from ADR-195 is 52px wide and paints its own `var(--dim)` background with a right border, so the green light lands on top of the rail's border. The tab bar's `.railSidebar` inset keeps tabs clear of the lights but can't stop the rail edge running through them.

The top of the window is also owned piecemeal. The full sidebar has a 32px `.titlebar` row holding back/forward and notifications. The rail has a 32px drag spacer and drops back/forward entirely. Each pane's `TabBar` adds its own 12px top padding, and in `hidden` mode every `TabBar` (not just the top-left one) gets a 78px left inset.

We mocked five layouts (https://claude.ai/artifact/KBrxe2ikVHKKsbhLUgvWhU). The user chose **Option E**: tabs stay in the top row (no extra title bar, as in Chrome/Arc), and the sidebar and workspace become rounded panels on the window's darkest shade (as in Slack).

One constraint shaped the details. Tab bars are per panel: `LeafPanel` renders its own `TabBar`, and panel splits (`SplitPanelLayout`) can put several side by side, or one under another. A single "title bar with tabs" component can't exist. Instead, every panel's tab bar sits on the dark frame above its own rounded body, so the top row of panels naturally forms the title row.

## Decision

### 1. Frame

- `.app` background becomes `var(--bg-deep)` (theme-aware, already defined in `App.css` as `--bg` mixed 80% with black). This is the "frame".
- The macOS `backgroundColor` in `electron/window.ts` (both windows) changes to the default theme's `--bg-deep` equivalent so the pre-paint flash matches. `trafficLightPosition` becomes `{ x: 13, y: 14 }` so the lights centre in a 40px row.
- The frame has a 6px gutter (`--frame-gap: 6px` on `:root` in `App.css`) between every panel and on the right and bottom window edges. The left edge gets the gutter only when the sidebar is `full`; the rail sits flush.

### 2. `WindowLead`: the top-left controls

New `src/components/window-lead/WindowLead/` (`WindowLead.tsx`, `WindowLead.module.css`). App renders it once, absolutely positioned at the top-left of `.app-body`, 40px tall, `-webkit-app-region: drag` with its buttons `no-drag`, transparent background.

Contents, left to right: 78px empty space for the traffic lights, then a sidebar toggle (`PanelLeft` icon, calls `toggleSidebarRail`, tooltip shows the `toggle-sidebar` binding), back, forward. In `full` mode it also shows `<NotificationsPopover />` pushed to its right end, which is where it sits today. The rail keeps its own footer notifications button.

Back/forward move here from `Sidebar.tsx` (the `navControls` block, its labels and `canGoBack`/`canGoForward` wiring) unchanged. `Sidebar`'s `.titlebar` row is removed.

Width, from a pure helper `windowLeadWidth(mode, sidebarWidth)` in `src/lib/window-lead.ts`:
- `full`: `sidebarWidth` (the lead sits directly above the sidebar panel)
- `rail` and `hidden`: `LEAD_COMPACT_WIDTH = 150`

### 3. Top-left tab bar inset

`App.tsx` sets a CSS variable `--window-lead-inset` on `.app-body` from `windowLeadInset(mode, sidebarWidth)` = `max(0, windowLeadWidth - leftColumnWidth)`: `full` → 0, `rail` → 150 − 52 = 98, `hidden` → 150. `:root` defaults it to `78px` so `DetachedApp` (no lead, no sidebar) still clears the lights.

Only the **top-left** panel's `TabBar` applies `padding-left: var(--window-lead-inset)`. `topLeftPanelId(node: PanelNode)` in `src/store/panel-tree.ts` follows `first` until it reaches a leaf. `TabBar`'s `.noSidebar` and `.railSidebar` classes and its `sidebarMode` read are removed. This also fixes the old quirk where every pane in `hidden` mode got a 78px inset.

### 4. Panels

- **Sidebar (`full`)**: starts 40px from the top (the lead is above it) and becomes a panel: `var(--dim)` background, `1px solid var(--border)`, `border-radius: 8px`, no `border-right`. `SidebarResizeHandle` moves into the gutter to its right.
- **Rail**: transparent background, no border, 40px top spacer, flush to the window's left edge.
- **`LeafPanel`**: the `TabBar` renders on the frame with a transparent background and a 40px row height (tabs bottom-aligned, no 12px top padding). The `.terminal-container` below it becomes the panel body: `var(--bg)` background, `1px` border, `border-radius: 8px`, `overflow: hidden`.
- **Active tab**: `var(--surface)` background as today, plus a 1px border on its top and sides in `var(--border)`, `margin-bottom: -1px` so it covers the panel body's top border and reads as one shape with it. The panel body's top-left corner stays rounded; the first tab starts 8px in, clear of the curve.
- **Panel splits**: `SplitPanelLayout` stops sharing `PaneLayout.module.css` dividers. It gets its own module with a `--frame-gap`-wide transparent divider that shows `var(--accent)` on hover/drag. Pane splits inside a tab keep their 3px divider.
- **Empty surface** (home, projects overview, wizard): the `.drag-region` above it becomes 40px on the frame, and `.terminal-container` inside `.empty-surface` gets the same panel styling.
- **Status bar**: stays at the bottom of `.main-content`, on the frame: transparent background, no top border.

## Consequences

**Better**
- The overlap is gone at the cause. Nothing under the traffic lights has an edge: rail, lead and tab bars are all on the frame.
- Back/forward are reachable in every sidebar mode, and the sidebar toggle has a visible button.
- No vertical space is lost: the 40px top row equals today's 12px padding plus the 28px tab row, and the sidebar gains the 32px its title row used.
- Each panel split reads as its own object, which makes it clearer which panel a tab belongs to.

**Worse / risks**
- The gutters cost about 12px of width and 6px of height. Terminals resize once on upgrade.
- When the sidebar toggles, the top-left panel's first tab shifts sideways (lead width changes). Accepted for now; a fixed lead width is an easy follow-up if it bothers.
- Every panel body sits 6px from its neighbours, so drag-and-drop split hints and the tab bar drop target (`tabBarDropTarget`, `tabBarSplitHint`) need a check against the new transparent tab bar.
- Rounded panel corners clip the terminal's corner cells slightly. xterm has its own padding, so this should be invisible.
- Themes: the frame uses `--bg-deep`, which every theme derives from `--bg`, so no theme needs new tokens. Light themes get a darker frame around a light panel, which should be checked by eye.
- Linux and Windows have no traffic lights. The 78px lead space stays so the layout is the same everywhere; it doubles as a drag handle.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
