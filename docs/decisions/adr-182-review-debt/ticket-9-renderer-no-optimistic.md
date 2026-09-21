---
title: Renderer holds no optimistic tree data; store tests use the real LayoutStore
status: todo
priority: medium
assignee: opus
blocked_by: [8]
---

# Renderer holds no optimistic tree data; store tests use the real LayoutStore

ADR-182 D9.

## Side maps
- **Current behaviour.** `paneContentType` and `paneUrl` in `src/store/app-store.ts` repeat leaf data. Seven actions write to them optimistically:
  - `addBrowserTab`
  - `addDiffTab`
  - `duplicateTab`
  - `openOrFocusDiff`
  - `openDiffInNewPanel`
  - `splitPaneAt`
  - `setPaneContentType`
- **Merge bug.** The broadcast merge only adds entries (~1045), so stale values survive.
- **Replace with selectors.** Replace both maps with selectors over the tree, backed by a `WeakMap<WorkspaceLayout, Map<paneId, leaf>>` index. Add hooks such as `usePaneContentType(paneId)`.
- **Keep one thing local.** Keep a renderer-only map only for the webview's live, unsaved URL, if a component needs one. Name it for that purpose.
- **Update consumers.** Grep for `paneContentType` and `paneUrl` across `src/` and update every consumer.

## Layout maps
- Merge `serverLayouts` and `workspaceLayouts` into one map, plus a `mountedWorkspaces: Set<string>` (or a record, if Zustand serialisation prefers it).
- Delete the leftover `const merged = layout;` (~1010).

## Claim out of the viewport
- `OWN_CLAIM` is fixed for the renderer's life, yet it is copied into `viewport.claim` (~1023, ~1310).
- Keep the claim out of `WorkspaceViewport`. Visibility helpers in `src/lib/layout/viewport.ts` take a single `Visibility` object instead of the positional `(claims, platform, ownClaim)` triple.
- Delete `claimOf` (unused) and `LayoutStore.ensure`, if it is test-only.

## Fake server
- Replace `src/store/__tests__/fake-layout-server.ts` with the real `LayoutStore`, constructed with in-memory persistence and stub broadcast/pty. Keep thin recording shims.
- Type the fake API as `ElectronAPI["layout"]`.
- Update the store tests (they may need `await`).

## Files to touch
- `src/store/app-store.ts`, `src/lib/layout/viewport.ts`, `src/lib/layout/visible-tabs.ts`, the components reading `paneContentType`/`paneUrl`
- `electron/layout/layout-store.ts`, `src/store/__tests__/*`
