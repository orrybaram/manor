---
title: MCP tools-panes module — split_pane, new_terminal, new_browser
status: todo
priority: high
assignee: sonnet
blocked_by: [4]
---

# MCP `tools-panes` module

New `electron/mcp/tools-panes.ts` exporting `panesModule: ToolModule`, following
`tools-projects.ts` / `tools-agents.ts` exactly (see `electron/mcp/types.ts:24-40`
for the contract, and the `text()` helper).

## Register it

`electron/mcp-webview-server.ts:101`:

```ts
const modules = [webviewModule, projectsModule, agentsModule, panesModule];
```

Nothing else changes — `TOOLS` and `handlers` are a flat compose.

## Tools

### `list_panes`
No args. `GET /panes`. Format the snapshot as an indented tree, one line per
pane, marking the focused pane and active tab. Include `paneId` verbatim on every
line — it is the join key for every webview tool.

### `split_pane`
```
{ paneId?: string, direction: "horizontal" | "vertical",
  position?: "first" | "second", contentType?: "terminal" | "browser" | "diff",
  url?: string, command?: string }
```
`POST /panes/split`. Returns `Split <target> <direction>. New pane: <paneId>`.

Description must explain: `paneId` defaults to the focused pane; `horizontal`
splits side-by-side, `vertical` stacks; `position: "second"` (default) puts the
new pane right/below, `"first"` puts it left/above; `contentType` defaults to
`terminal`; `url` applies only to `browser`; `command` auto-runs in a `terminal`.

### `new_terminal`
```
{ workspacePath?: string, command?: string }
```
`POST /tabs` with `contentType: "terminal"`. Returns the new `tabId` and `paneId`.

### `new_browser`
```
{ url: string, workspacePath?: string, background?: boolean }
```
`POST /tabs` with `contentType: "browser"`. Returns the new `tabId` and `paneId`.

**The description must state** that the returned `paneId` is usable with
`navigate`, `screenshot_webview`, `get_dom`, `click_element`, `type_text`, and
`get_console_logs` — and that the pane needs a moment to mount, so a webview call
issued immediately may 404; retry once. (See ADR Risks: we deliberately don't
block on mount.)

### `focus_pane` / `close_pane`
`{ paneId: string }`. `POST /panes/:id/focus`, `DELETE /panes/:id`.

`http` has `get`/`post`. If it has no `del`, add one to the http client in
`electron/mcp-webview-server.ts` and to the `Http` interface in
`electron/mcp/types.ts`, mirroring `post`. Do not work around it with a POST.

## Handler style

Match `tools-projects.ts:171-192`: build a **sparse** body (omit `undefined` keys
so main's defaults win), `await http.post(...)`, return `text(...)` with a
human-readable summary. Errors propagate — `handleTool`
(`mcp-webview-server.ts:105-129`) already converts throws into an error
`ToolResult` and maps connect failures to `"Cannot connect to Manor — is it running?"`.

## Files to touch

- `electron/mcp/tools-panes.ts` — new
- `electron/mcp-webview-server.ts` — add `panesModule` to `modules`; add `http.del` if absent
- `electron/mcp/types.ts` — add `del` to `Http` if absent

## Note

Do not add tools for panel (editor-group) splits — out of scope per the ADR.
`split_pane`'s `contentType` intentionally omits `"task"`: `start_agent` already
covers that path and takes a workspace, not a pane.
