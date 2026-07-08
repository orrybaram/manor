---
title: Pane tools target the caller's pane, not the user's focus
status: done
priority: critical
assignee: sonnet
blocked_by: [9]
---

# Pane tools target the caller's pane, not the user's focus

Fixes correctness bug #3 — the bug ADR-150 was written to prevent, reintroduced
by ADR-149's tools in the same branch.

## The bug

ADR-150 `index.md:58` rejects renderer-focus state in these words:

> `selectedProjectIndex` / `selectedWorkspaceIndex` — **Wrong.** Tracks the user's
> focus, not the agent's pane. A background agent in workspace A while the user
> views workspace B gets the wrong answer.

Yet, in the same branch:

- `src/lib/app-commands.ts` `splitPane` defaults its target to the active panel's
  focused pane.
- `newTab` with no `workspacePath` creates the tab in the **user's** active workspace.
- `electron/mcp/tools-panes.ts:73` — schema says *"Defaults to the focused pane."*

`MANOR_PANE_ID` is in the MCP process's environment — `electron/mcp/context.ts:37`
already reads it, and `electron/pty.ts:27` sets it. The pane tools never send it.

**Traced failure:** a background agent in workspace B calls
`split_pane({direction: "horizontal"})` → MCP omits `paneId` → `POST /panes/split`
→ `proxyToRenderer` → `splitPane` → `requireActiveLayout` reads
`activeWorkspacePath = A` → **splits a pane in the workspace the user is looking at.**

## What to do

All changes are in the MCP process (`electron/mcp/tools-panes.ts`). The renderer
handlers keep their existing "no paneId → focused pane" fallback as the last
resort; we simply stop reaching it.

### 1. `split_pane` and `close_pane` default to the caller's pane

```ts
const callerPaneId = () => process.env.MANOR_PANE_ID || undefined;
```

`split_pane`: when `args.paneId` is absent, send `callerPaneId()`.
`close_pane`: `paneId` is `required` in its schema — leave it required. Closing
the caller's own pane by default would be a hostile default.

Update `split_pane`'s schema description: *"Pane to split. Defaults to the pane
this agent is running in."*

### 2. `new_terminal` and `new_browser` default to the caller's workspace

When `args.workspacePath` is absent:

```ts
const { workspacePath } = await resolveContext(http);
```

`resolveContext` is already imported in `tools-agents.ts` from `./context` and is
exactly the `/context` route's purpose. Send the resolved path explicitly rather
than letting the renderer fall back to `activeWorkspacePath`.

Update both schema descriptions: *"Defaults to the workspace this agent is
running in."*

Note ticket 3 made `new-tab` restore the user's active workspace afterwards, so
these two fixes compose: the agent's tab is created in the agent's workspace, and
the user's view never moves.

### 3. `MANOR_PANE_ID` may be absent

An MCP client not launched from a Manor PTY has no `MANOR_PANE_ID`. In that case
`split_pane` sends no `paneId`, the renderer falls back to the focused pane, and
behavior is unchanged from today. Do not throw — `resolveContext` already handles
the analogous case for `/context` by falling through to `cwd`.

## Files to touch
- `electron/mcp/tools-panes.ts` — `callerPaneId()`; `split_pane` default; `new_terminal`/`new_browser` resolve `workspacePath` via `resolveContext`; three schema descriptions

## Verify
`pnpm typecheck` clean. New tests in a new `electron/mcp/tools-panes.test.ts`
driving the handlers against a fake `Http` (`{get, post, del}` — a 6-line stub):

- with `MANOR_PANE_ID=pane-7` set, `split_pane({direction})` POSTs `{direction, paneId: "pane-7"}`
- with it unset, `split_pane({direction})` POSTs `{direction}` and no `paneId`
- `new_terminal({})` calls `GET /context` and POSTs the resolved `workspacePath`
- an explicit `args.paneId` / `args.workspacePath` always wins

Also assert `formatLayoutSnapshot` (ticket 1) prints exactly one `[focused]` —
this file currently has **zero** coverage.
