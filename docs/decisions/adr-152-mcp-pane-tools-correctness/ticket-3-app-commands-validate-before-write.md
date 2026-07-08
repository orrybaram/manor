---
title: app-commands — validate before write, never move the user, one scope
status: done
priority: critical
assignee: sonnet
blocked_by: [2]
---

# app-commands — validate before write, never move the user, one scope

Fixes correctness bug #4 and consumes ticket 2's new store contract.

## The bug

`src/lib/app-commands.ts:207-238` (`newTab`):

```
214    state.setActiveWorkspace(workspacePath);   // ← writes
217    const contentType = parseEnum(...)          // ← throws
222    const url = optionalString(args, "url");    // ← throws
224    const background = optionalBoolean(...)     // ← throws
232    if (!url) throw new Error(...)              // ← throws
```

`POST /tabs {"contentType":"terminal","workspacePath":"/other","background":"yes"}`
passes the route guard, switches the user's workspace, then 400s. The module's
own docstring (lines 10-14) promises *"every handler validates before it writes."*

Worse, `setActiveWorkspace` is never restored, so any cross-workspace tab
creation yanks the user's UI — which `background: true` explicitly promises not
to do (it is read at line 233, *after* the workspace already changed).

## What to do

### 1. `newTab` — parse everything, then act, then restore

```ts
function newTab(args) {
  // 1. parse — no store writes above this line
  const workspacePath = optionalString(args, "workspacePath");
  const contentType   = parseEnum<TabContentType>(args.contentType, TAB_CONTENT_TYPES, "contentType");
  const url           = optionalString(args, "url");
  const command       = optionalString(args, "command");
  const background    = optionalBoolean(args, "background");

  if (contentType === "browser" && !url) throw new Error('new-tab with contentType "browser" requires a url');
  if (contentType !== "browser" && url) throw new Error("url applies only to contentType 'browser'");
  if (contentType !== "browser" && background !== undefined) {
    throw new Error("background applies only to contentType 'browser'");
  }

  const state = useAppStore.getState();
  if (workspacePath && !isKnownWorkspace(state, workspacePath)) {
    throw new Error(`Unknown workspace: ${workspacePath}`);
  }

  // 2. act
  const previous = state.activeWorkspacePath;
  if (workspacePath) state.setActiveWorkspace(workspacePath);
  try {
    const fresh = useAppStore.getState();   // setActiveWorkspace is a sync set()
    requireActivePanel(fresh);
    const created =
      contentType === "browser" ? fresh.addBrowserTab(url!, { background })
      : command                 ? fresh.addTerminalTab(command)
      :                           fresh.addTab();
    if (!created) throw new Error("Tab was not created");
    return created;                          // { tabId, paneId } — from ticket 2
  } finally {
    // 3. never move the user. `new-tab` is MCP-only; an agent that wants the
    //    user to look at its tab calls focus_pane.
    if (workspacePath && previous && previous !== workspacePath) {
      useAppStore.getState().setActiveWorkspace(previous);
    }
  }
}
```

Note `created` comes straight from the store (ticket 2). This is what makes the
restore possible at all: `findTabIdForPane` searched the *active* layout, which
after restoring is no longer the layout the tab was created in.

### 2. Delete `findTabIdForPane` and `panelHasPane`

- `findTabIdForPane` (lines 132-140) — obsoleted by ticket 2's return values.
- `panelHasPane` (lines 120-123) — ticket 2 gave `closePaneById`/`splitPaneAt`
  all-panel scope, so `layoutHasPane` is the only scope left.

`splitPane` and `closePane` now validate with `layoutHasPane(requireActiveLayout(state), paneId)`,
matching `focusPane`. Drop their `requireActivePanel` calls and the
`// closePaneById only searches the active panel` comment at line 259 — it is no
longer true.

`splitPane` still defaults its target to the active panel's focused pane when no
`paneId` is given; ticket 9 replaces that default with the caller's pane.

### 3. `splitPane` — reject incoherent combinations

```ts
if (url && contentType !== "browser") throw new Error("url applies only to contentType 'browser'");
if (paneCommand && (contentType === "browser" || contentType === "diff")) {
  throw new Error("command applies only to a terminal or task pane");
}
```

Stop pre-minting: `const paneId = state.splitPaneAt(target, direction, position, { contentType, paneCommand, url });`
and `if (!paneId) throw new Error(...)`. Remove the `newPaneId` import.

### 4. Fix the test that enshrines the bug

`src/lib/__tests__/app-commands.test.ts:170-182` asserts that
`split-pane {contentType:"browser", url, command}` writes
`pendingPaneCommands[paneId]` on a browser pane. Change it to assert the throw.

Add tests: `new-tab` with a bad `background` leaves `activeWorkspacePath`
unchanged; `new-tab` with a `workspacePath` restores the previous workspace;
`split-pane`/`close-pane` succeed on a pane in a non-active panel.

## Files to touch
- `src/lib/app-commands.ts` — reorder `newTab`; delete `findTabIdForPane`, `panelHasPane`, the `newPaneId` import; coherence checks; use ticket 2's return values
- `src/lib/__tests__/app-commands.test.ts` — fix the enshrined bug; add the four tests above

## Verify
`pnpm typecheck` clean, `pnpm test app-commands` green. `newTab` contains no
store write above its last `throw`.
