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

# ADR-155: Navigation History Stack

## Context

The renderer has **no router**. Which screen shows is decided by a conditional
cascade in `src/App.tsx:594-615`, keyed off the Zustand field
`app-store.activeWorkspacePath`. The only "back" navigation that exists anywhere
is the CommandPalette's hand-rolled `useState<PaletteView>` state machine
(`src/components/command-palette/CommandPalette.tsx`). There is no way to move
back/forward across surfaces, workspaces, or tabs the way a native app lets you.

We want each meaningful view transition to be pushed onto a history stack that
can be navigated back and forward.

**This app is a navigation stack, not a URL app.** No server, no URL bar, no
deep links. We evaluated `react-router` v8 (`createMemoryRouter`),
`@tanstack/react-router` v1 (`createMemoryHistory`), and `wouter` v3
(`memoryLocation`). All three are fundamentally *URL matchers* that offer an
in-memory backend as a side option — adopting one means inventing fake URLs
(`/session/:id`) for views that will never be URLs, then translating back. That
is pure impedance mismatch for this app. The data structure we want — a stack of
`{ name, params }` descriptors with push/pop/replace — *is* the implementation,
in ~40 lines over the `zustand@^5.0.12` we already ship. A TypeScript
discriminated union gives us compile-checked, param-narrowed navigation with zero
codegen — matching TanStack Router's headline benefit for our exact use case,
without a URL router.

## Decision

Roll our own typed history stack in Zustand. The governing principle:

> **The history stack does not OWN the current location. It owns the HISTORY of
> locations. Current location stays derived from the layout store.**

This is what prevents two sources of truth. The layout tree in `app-store`
(`panelTree`, `panels`, `activePanelId`, `panel.selectedTabId`, `activeWorkspacePath`)
remains the sole authority for *what exists* and *what is focused now*. The
history store stores only **coordinates** (addresses) into that layout — never
copies of it.

### Granularity (settled)

The stack records transitions at **surface / workspace / tab** granularity.
**Pane focus is NOT tracked** — because this is a single-window app, all pane
focus changes are same-window and are deliberately skipped. This also eliminates
any need for debounce/coalescing of rapid pane-focus events.

```ts
type Location =
  | { kind: "surface"; surface: "home" }
  | { kind: "workspace"; workspacePath: string; panelId: string; tabId: string };
```

No `paneId`. Coordinates carry enough to re-select the workspace, panel, and tab.

### Pieces

1. **`src/store/navigation-history-store.ts`** — pure store, no `app-store` import
   (avoids a circular dependency). Holds `{ entries: Location[]; index: number }`
   plus `isNavigating: boolean`. Actions: `record(loc)` (truncate forward entries,
   push, skip if equal to current entry), `goBack()`/`goForward()` (move index,
   set/clear `isNavigating`, return the target `Location`), `canGoBack`/`canGoForward`,
   `reset()`. **Not persisted** — history resets each launch.

2. **Current-location selector** — a pure function over `app-store` state that
   computes the current `Location` (from `activeWorkspacePath` → `activePanelId`
   → `panel.selectedTabId`).

3. **Navigator bridge** (`src/hooks/useNavigationHistory.ts` or a small controller
   module) — the ONE place that knows the history↔layout mapping, in both
   directions:
   - **Record**: subscribe to the current-location selector. When it changes and
     `isNavigating` is false, call `record(loc)`.
   - **Replay**: `goBack`/`goForward` read the target `Location`, then dispatch the
     **existing** `app-store` actions (`setActiveWorkspace`, `focusPanel`,
     `selectTab`) to make the layout match. Wrapped so the recorder does not
     re-push (the `isNavigating` guard).
   - **Prune**: before replaying, validate the target coordinate against the live
     layout tree. If the workspace/panel/tab no longer exists, drop that entry and
     continue to the next valid one.

4. **Overlays stay separate.** Settings and CommandPalette keep their own local
   state machines and are NOT on this stack. `Esc` dismisses the overlay; it never
   `goBack`s the main history.

5. **Keybindings** — add `history-back` / `history-forward` commands in
   `src/lib/keybindings.ts` and register handlers in `App.tsx`'s keydown handler
   map (`src/App.tsx:382`, dispatched at `:467-493`). `Cmd+[`/`]` (pane) and
   `Cmd+Shift+[`/`]` (tab) are already taken — use `Cmd+Ctrl+Left`/`Cmd+Ctrl+Right`
   as defaults, and also wire the mouse back/forward buttons. Optional: back/forward
   arrow `<Button>`s in the chrome.

## Consequences

**Better**
- True back/forward across surfaces, workspaces, and tabs — native feel.
- Single source of truth preserved: layout owns state; history only references it.
- Fully typed navigation via a discriminated union; no codegen, no module augmentation.
- No new dependencies; ~small surface built on existing Zustand.
- Reuses existing focus actions for replay — no new mutation paths into the layout.

**Harder / risks**
- The recorder subscription must be carefully `isNavigating`-guarded or it forms a
  feedback loop (replay → location change → re-record). This is the main correctness
  risk and is concentrated in the navigator bridge.
- Coordinates can go stale (pane/tab/workspace closed after being recorded); replay
  must prune-and-skip rather than crash.
- Coarse granularity is a deliberate limitation: switching panes within a tab is not
  in the history. Accepted.
- No deep-linking / restorable-URL story; a future need would require serializing
  the descriptor ourselves. Out of scope.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
