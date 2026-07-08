---
title: Renderer app-command handlers for pane/tab commands
status: todo
priority: high
assignee: opus
blocked_by: [1, 2]
---

# Renderer app-command handlers for pane/tab commands

Extract dispatch out of the inline `App.tsx` switch (`src/App.tsx:284-301`) into a
handler map, and add the six correlated pane/tab commands.

## New module: `src/lib/app-commands.ts`

A pure map of `cmd → (args) => unknown | Promise<unknown>`, operating on
`useAppStore.getState()`. No React, no hooks — this keeps it unit-testable and
keeps `App.tsx` from growing another branch per tool.

```ts
type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>;
export const appCommandHandlers: Record<string, Handler> = { … };
```

Handlers:

| cmd | args | returns |
|---|---|---|
| `list-panes` | — | `getLayoutSnapshot()` |
| `split-pane` | `paneId?`, `direction`, `position?`, `contentType?`, `url?`, `command?` | `{ paneId }` |
| `new-tab` | `contentType`, `url?`, `command?`, `workspacePath?`, `background?` | `{ tabId, paneId }` |
| `focus-pane` | `paneId` | `{ ok: true }` |
| `close-pane` | `paneId` | `{ ok: true }` |

Rules:

- **Mint IDs in the handler**, pass them into the store, return them. E.g.
  `const paneId = newPaneId(); store.splitPaneAt(target, dir, pos, { ...opts, paneId }); return { paneId };`
  Same for `newTabId()` where a tab is created — if the store action doesn't
  accept a `tabId`, read the new tab back from state after `set()` (zustand's
  `set` is synchronous, so `useAppStore.getState()` immediately after the call
  sees it). Prefer reading back over widening more store signatures.
- **`split-pane` target defaults** to the active tab's `focusedPaneId`. If the
  store has no active panel context, or `paneId` names a pane that doesn't
  exist, **throw** — the dispatcher turns throws into `{ ok: false, error }`,
  which becomes an HTTP 400/503. Silently no-op'ing (what `splitPaneAt` does
  today via `if (!tab) return state;`) would make the tool lie.
- **`position` defaults to `"second"`** (right for horizontal, below for
  vertical), matching `splitPane`.
- **`workspacePath`**, when present on `new-tab`, calls `setActiveWorkspace`
  first — every store action operates on the active panel context. Throw if the
  path is not a known workspace, rather than creating a tab in the wrong place.
- **Validate `direction`** against `"horizontal" | "vertical"` and `contentType`
  against the union. Throw on anything else. Do not trust main's body parsing.
- `close-pane` maps to `closePaneById`; `focus-pane` to whatever
  `app-store.ts` exposes for focusing a pane by ID (grep — `focusPane` or the
  `selectedTabId`/`focusedPaneId` update used by `focusNextPane`). If no
  by-ID focus action exists, add one; do not reimplement the traversal here.

## Wire into `App.tsx`

In the `onAppCommand` listener (`src/App.tsx:284`):

```ts
const cleanup = window.electronAPI.onAppCommand(async (payload) => {
  const { cmd, requestId } = payload;

  // Uncorrelated legacy commands — depend on App.tsx's useCallback refs.
  if (cmd === "start-agent" || cmd === "run-setup-script") { …unchanged… ; return; }

  if (!requestId) return;
  try {
    const data = await appCommandHandlers[cmd]?.(payload.args ?? {});
    if (!appCommandHandlers[cmd]) throw new Error(`Unknown command: ${cmd}`);
    window.electronAPI.sendAppCommandResult({ requestId, ok: true, data });
  } catch (err) {
    window.electronAPI.sendAppCommandResult({
      requestId, ok: false, error: err instanceof Error ? err.message : String(err),
    });
  }
});
```

Keep `start-agent` / `run-setup-script` exactly as they are — including
`await loadProjects()` before `setActiveWorkspace` (ADR-144's workspace-visibility
race). Do not route them through the handler map; they close over
`handleNewTaskWithPromptRef` / `handleNewTaskRef`.

Note the `Unknown command` check must run before the `?.()` short-circuits to
`undefined` — an unknown cmd must reply `ok: false`, not `ok: true, data: undefined`,
or main hangs until timeout.

## Files to touch

- `src/lib/app-commands.ts` — new; the handler map
- `src/App.tsx` — replace the listener body per above; leave the two legacy branches intact
- `src/store/app-store.ts` — add a focus-pane-by-id action only if one doesn't exist
- `src/lib/__tests__/app-commands.test.ts` — new. Drive `useAppStore.setState()` to
  build a layout, call handlers directly, assert returned IDs match store state.
  Cover: `split-pane` default target = focused pane; unknown `paneId` throws;
  invalid `direction` throws; `new-tab` with `contentType: "browser"` sets
  `paneUrl`; `new-tab` with `workspacePath` switches workspace first; unknown
  workspace throws.
