---
title: Phone and web as seams — drag, BrowserPane, SplitFrame, PhoneChrome, paneTitle
status: in-progress
priority: medium
assignee: opus
blocked_by: [11]
---

# Phone and web as seams — drag, BrowserPane, SplitFrame, PhoneChrome, paneTitle

ADR-182 D11, UI half.

## Drag
- **Current state.** Drag is disabled for phone in 6 places: `LeafPane.tsx:~330`, `PaneDragContext.tsx:~43`, `PaneDropZone.tsx:~143`, `TabBar.tsx:~578-597`, `Sidebar.tsx:~127,446` and `useSidebarDrag.ts:~81`.
- **Change:**
  - `PaneDragProvider` exposes `dragEnabled`, and drag sources read it.
  - Delete the `PaneDropZone` check, since a drop zone cannot mount without a drag.
  - `Sidebar` passes `disabled={isPhone}` to `useSidebarDrag`, which stops reading `useLayoutMode` itself.

## BrowserPane
- **Current state.** 11 `if (webApp) return;` guards in `useImperativeHandle` (`BrowserPane.tsx:~311-373`), plus an early return (~571).
- **Change:** `LeafPane` (~608) mounts a `<BrowserPaneUnavailable>` in the web app, with no-op ref methods. The real `BrowserPane` loses every web guard.

## SplitFrame
- **Current state.** `SplitLayout.tsx` and `SplitPanelLayout.tsx` both carry the same `PHONE_SPLIT_STYLE`, `PHONE_DIVIDER_STYLE`, style ternaries, divider and drag handler.
- **Change:**
  - Extract `src/components/workspace-panes/SplitFrame.tsx`, with the props `direction`, `ratio`, `focusInSecond`, `onCommitRatio`, `first` and `second`.
  - Pass `tabId` down through `PaneLayout`, so `SplitLayout` checks `paneTreeContains(second, focusedPaneIds[tabId])` instead of `findPanelWithPane(...)` on every store update.

## PhoneChrome
- **Current state.** `App.tsx` (916 lines) has 4 `layoutMode` checks and phone state (~101-102).
- **Change:**
  - Extract `src/components/phone/PhoneChrome.tsx`. It owns the drawer and switcher state and renders `SidebarDrawer`, `PaneSwitcherSheet` and `PhoneTopBar`.
  - `App.tsx` renders the chrome through one slot.
  - Move the duplicated `CloseAgentPaneDialog` pair and `ToastContainer` (~685-708 and ~885-908) out of the detached fork.
  - Export one `workspaceDisplayName(path)` (dedupe `App.tsx:~357` and `WorkspaceSetupView.tsx:~82`); `PhoneTopBar` reads the name itself.

## paneTitle
- **Current state.** The same pane-title logic lives in `PaneSwitcherSheet.titleForPane` (~28-72), `useTabTitle.ts` (~27-56) and `TabBar.deriveTabTitle` (~31).
- **Change:**
  - Write one pure `paneTitle(paneId, state, agents)` in `src/lib/pane-title.ts` and use it in all three places.
  - The `PaneSwitcherSheet` rows use `<Button>` from `src/components/ui/Button/Button`, not a raw `div role="button"`.
  - Render the list in a child component inside `Dialog.Content`, so it does not subscribe while closed.

## Stale ticket comments
Remove the "Ticket 4/5/6" comments in `PhoneTopBar` and `App.tsx`.

## Files to touch
- `src/components/workspace-panes/{LeafPane,PaneDragContext,PaneDropZone,SplitLayout,SplitFrame}.tsx`, `src/components/panels/SplitPanelLayout.tsx`, `src/components/tabbar/TabBar/TabBar.tsx`, `src/components/sidebar/Sidebar/Sidebar.tsx`, `src/hooks/useSidebarDrag.ts`
- `src/components/workspace-panes/BrowserPane/*`, `src/App.tsx`, `src/components/phone/*`, `src/hooks/useTabTitle.ts`, `src/lib/pane-title.ts` (new), and the tests
