---
title: Derive ElectronAPI from the handler table and share layout wire types
status: done
priority: high
assignee: opus
blocked_by: [3]
---

# Derive ElectronAPI from the handler table and share layout wire types

ADR-182 D4.

## Why
- **Written three times.** Bridge method signatures appear in `src/electron.d.ts`, the handler table and `handlers/*.ts`.
- **Checked by name only.** `electron/bridge/surface.ts` (307 lines) compares names, not signatures (see its header, :42-45).
- **Already drifted.** `webview.onPickerResult` is `unknown` in `preload.ts:230` and `PickedElementResult` in `d.ts:1033`.
- **Loosely typed.** 31 handlers return `unknown`, and `ManorHost.native` is `Record<string, unknown>`.

## Derive the interface
- Add `ClientOf<T>` in a type-only module importable from `src/`, e.g. `electron/bridge/contract.ts` or `src/bridge/contract.ts`, depending on tsconfig reach. Check how `surface.ts` imports across programs today and follow that.
- `ClientOf` maps each `"ns.method"` entry to `ns: { method(...wireArgs): Promise<Awaited<R>> }`, stripping the `ctx` parameter.
- Build `ElectronAPI` as `HostFacts & NativeApi & ClientOf<typeof HANDLERS> & Listeners`.
- Type `NativeApi` from the preload's `nativeApi` object (export its type) and drop the duplicate d.ts declarations.
- Type `ManorHost.native` as `NativeApi`, and delete the "shrinking subset" note.

## Listeners and events
- Derive listener names from `SUBSCRIPTIONS` in `surface.ts`, or move that table somewhere shared.
- Type `publish` / `publishRendererBroadcast` so the event name must be a key of that table (29 call sites).

## Return types and surface.ts
- Replace `unknown` handler return types with real types wherever the handler's body makes them obvious.
- Delete the assertions in `surface.ts` that derivation makes redundant. Keep only what can't be derived.

## Layout wire types
- Create `src/lib/layout/protocol.ts`, containing only pure types, that is the single definition of:
  - `LayoutBroadcast`
  - `LayoutEntry`
  - `LayoutApplyResult`
  - `PersistedViewportFile`
  - `PersistedPaneSession`
- Import it from `electron/layout/layout-store.ts`, `electron/bridge/handlers/viewport.ts`, `src/electron.d.ts` and `src/store/__tests__/fake-layout-server.ts`.
- Resolve the drift: `origin` is required, and `lastAgentStatus` uses one type.
- Normalise `Panel.pinnedTabIds` once at load in `electron/terminal-host/layout-persistence.ts`, then remove the 17 `?? []` sites.

## Done when
- `src/electron.d.ts` ends under 1000 lines.
- `pnpm typecheck` is clean.

## Files to touch
- `src/electron.d.ts`, `electron/bridge/surface.ts`, `electron/preload.ts`, `electron/bridge/handlers/*.ts`, `electron/renderer-broadcast.ts`, `electron/renderer-bridge.ts`
- `src/lib/layout/protocol.ts` (new), `electron/layout/layout-store.ts`, `electron/terminal-host/layout-persistence.ts`, `src/store/__tests__/fake-layout-server.ts`, and the `pinnedTabIds` call sites
