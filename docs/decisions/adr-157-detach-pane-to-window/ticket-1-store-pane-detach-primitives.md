---
title: Store — pane-detach primitives
status: in-progress
priority: critical
assignee: opus
blocked_by: []
---

# Store — pane-detach primitives

Add two pane-scoped store functions that reuse the existing tab-detach pipeline,
mirroring `serializeTabForDetach` / `removeDetachedTabLocally`. A detached window
hosts a *tab*, and `DetachedTabPayload` already models a tab whose `rootNode` is
an arbitrary pane tree — so a detached pane is just a **single-leaf tab payload**.
No change to `DetachedTabPayload` and no new IPC.

## Behavior

### `serializePaneForDetach(paneId: string): DetachedTabPayload`
- Find the pane's owning tab across all workspace layouts (`findPanelWithPane`,
  as `extractPaneToTab` does), or throw if not found (match the tab version's
  throw).
- Build a `DetachedTabPayload` with:
  - `tab.id`: a fresh id (`newTabId()`), `tab.title`: `"Terminal"` (hydration
    recomputes the real title from pane state, same as tab detach),
    `tab.rootNode`: `{ type: "leaf", paneId }`, `tab.focusedPaneId`: `paneId`.
  - `paneState`: exactly the shape `serializeTabForDetach` builds, but populated
    for **only this one `paneId`** (copy each side-map entry that is defined).
  - `sourceWorkspacePath` + `themeName`: resolve identically to
    `serializeTabForDetach` (home → null, else the owning project's `themeName`).
- `return structuredClone(payload)` so no live store refs cross IPC.

### `removeDetachedPaneLocally(paneId: string)`
- Release **only this pane's** backend without terminating it, matching the
  per-pane branch in `removeDetachedTabLocally`:
  - `browser` → `window.electronAPI.webview.unregister(paneId)`
  - `diff` → no-op
  - terminal (default) → `window.electronAPI.pty.detach(paneId)`
- Then remove the pane from its source tab's tree with `removePane`
  (`../store/pane-tree`), collapsing the split:
  - If `removePane` returns a tree (pane was one of several) → update that tab's
    `rootNode` to the collapsed tree and fix `focusedPaneId` if it pointed at the
    removed pane (`allPaneIds(remaining)[0]`).
  - If `removePane` returns `null` (pane was the sole leaf) → the pane *was* the
    whole tab; remove the tab from its panel exactly as `removeDetachedTabLocally`
    does (reselect sibling / prune empty panel / fresh tab), and drop that pane's
    side-map entries.
- Do NOT terminate sessions — this must keep the daemon/webview alive so the pane
  re-attaches in the destination window (same guarantee as the tab path).

## Files to touch
- `src/store/app-store.ts` — add `serializePaneForDetach` and
  `removeDetachedPaneLocally` next to the ADR-156 detach block (~line 2713).
  Add both to the store interface type (near the `serializeTabForDetach` /
  `removeDetachedTabLocally` type declarations, ~lines 385/393). Reuse existing
  helpers: `findPanelWithPane`, `findPanelWithTab`, `allPaneIds`, `removePane`,
  `getActiveLayoutContext`, `newTabId`, `isHomePath`, `useProjectStore`.

## Notes
- No change to `src/store/detach-types.ts` — a pane payload IS a tab payload.
- Do not touch the IPC / preload / DetachedApp hydrate path; it already accepts a
  single-leaf tab.
