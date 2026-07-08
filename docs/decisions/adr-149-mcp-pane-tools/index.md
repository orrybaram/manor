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

# ADR-149: MCP Pane Tools — split, terminal, browser

## Context

Manor's MCP server exposes 20 tools (ADR-110, ADR-144, ADR-145): 11 webview
inspection tools, 6 project/workspace tools, 3 agent tools. An agent can create
a *workspace* and launch an *agent* into it, and it can drive a browser pane
that already exists — but it cannot create a pane, split one, or open a browser.
The app has all three capabilities (ADR-048 split panes, ADR-052 browser tab,
ADR-106 editor groups); they are reachable only from keybindings, context
menus, and the command palette.

The blocking problem is not the tools — it is the transport. Pane and layout
state lives entirely in the renderer's zustand store (`src/store/app-store.ts`).
Main cannot mutate it directly, so ADR-144 introduced a one-way
`webContents.send("app-command", …)` channel. That channel has **no
request/response correlation**: `start_agent` returns `{ ok: true }` the moment
`send()` returns, before the tab exists. ADR-144 accepted this, correctly, for a
tool whose only useful output is "launched."

Pane tools cannot accept it. A `split_pane` that does not return the new
`paneId` is close to useless: every webview tool
(`navigate`, `screenshot_webview`, `get_dom`, `click_element`, …) is keyed by
`paneId`, and `resolvePaneId` (`electron/mcp/tools-webview.ts:16`) only
auto-selects when exactly one webview is open. An agent that opens a second
browser pane and gets nothing back has to guess, or poll `list_webviews` and
set-diff — the same "snapshot before/after and diff" hack ADR-145 removed from
workspace creation.

A second gap: pane IDs are minted in the renderer (`newPaneId()`), so main
cannot pre-allocate one and hand it down.

Finally, there is no read tool for layout. `list_webviews` reports browser panes
only. Nothing tells an agent which tabs exist, which pane is focused, or what a
pane's content type is — all of which a split needs as its target.

## Decision

Add a **correlated request/response channel** on top of the existing
`app-command` bridge, then build six pane tools on it as a new MCP module.

### 1. Correlated `app-command` (the load-bearing change)

Extend the `AppCommand` payload with an optional `requestId`. When present, the
renderer must reply on a new `app-command-result` channel with
`{ requestId, ok, data?, error? }`. Main wraps this in a promise:

```ts
// electron/control-server.ts
export function requestRenderer<T>(
  command: Omit<AppCommand, "requestId">,
  timeoutMs = 5000,
): Promise<{ ok: boolean; data?: T; error?: string }>
```

Commands sent *without* a `requestId` keep today's fire-and-forget semantics, so
`start-agent` and `run-setup-script` are untouched. The renderer's dispatcher
resolves the request with whatever the handler returns; a handler that throws
becomes `{ ok: false, error }`; a window that never replies rejects on timeout.
No window open → `{ ok: false, error: "No Manor window is open" }`, matching
`startAgent`.

Correlation IDs are generated in main with `crypto.randomUUID()`. The listener
is registered with `ipcMain.on("app-command-result", …)` once at startup and
routes by `requestId` through a `Map<string, {resolve, timer}>` — not
`ipcMain.once`, which would leak on timeout.

### 2. Renderer: pane IDs in, results out

Two store actions gain an optional caller-supplied pane ID so the renderer
handler knows the ID it just created without reading state back:

- `splitPaneAt(target, dir, pos, contentType?, paneCommand?, url?, paneId?)`
- `addBrowserTab(url, { background?, paneId? })`

`addTab(paneId?)` already accepts one. `splitPaneAt` also gains `url`, which it
currently drops — splitting into a browser pane today produces a pane with no
URL (`app-store.ts:1154`, which sets `paneContentType` but never `paneUrl`).

Dispatch moves out of the inline `App.tsx` switch (`App.tsx:284-301`) into
`src/lib/app-commands.ts`, a pure map of `cmd → (payload) => Promise<data>` over
`useAppStore.getState()`. `App.tsx` keeps only the `start-agent` /
`run-setup-script` branches, which depend on its `useCallback` refs.

### 3. Layout snapshot

A `paneTreeSnapshot(state)` selector in `src/store/pane-tree.ts` flattens the
active workspace's panels → tabs → pane tree into a serializable shape:

```ts
{ workspacePath, tabs: [{ tabId, title, active, focusedPaneId,
    panes: [{ paneId, contentType, url?, split? }] }] }
```

### 4. Routes and tools

`electron/control-server.ts` gains a `panes` / `tabs` segment branch:

| Route | Renderer cmd | Returns |
|---|---|---|
| `GET /panes` | `list-panes` | layout snapshot |
| `POST /panes/split` | `split-pane` | `{ paneId }` |
| `POST /panes/:id/focus` | `focus-pane` | `{ ok }` |
| `DELETE /panes/:id` | `close-pane` | `{ ok }` |
| `POST /tabs` | `new-tab` | `{ tabId, paneId }` |

`POST /tabs` takes `{ contentType: "terminal" | "browser", url?, command?, workspacePath?, background? }`
and fans out to `addTab` / `addTerminalTab` / `addBrowserTab`. When
`workspacePath` is given the handler calls `setActiveWorkspace` first, since
every store action operates on the active panel context.

A new `electron/mcp/tools-panes.ts` module (registered in the `modules` array at
`mcp-webview-server.ts:101`) exposes:

- `list_panes` — the snapshot, formatted as an indented tree
- `split_pane` — `{ paneId?, direction, position?, contentType?, url?, command? }` → new `paneId`
- `new_terminal` — `{ workspacePath?, command? }` → `tabId`, `paneId`
- `new_browser` — `{ url, workspacePath?, background? }` → `tabId`, `paneId`
- `focus_pane` — `{ paneId }`
- `close_pane` — `{ paneId }`

`split_pane` covers both requested split axes (`direction: "horizontal" |
"vertical"`, matching `SplitDirection`) and, via `contentType`, doubles as
"split into a new terminal / browser / diff" — mirroring the existing
`SplitWithSubmenu`. `paneId` defaults to the focused pane; `position` defaults
to `"second"` (right / below), matching `splitPane`.

`new_browser` returns a `paneId` that is immediately valid for `navigate`,
`screenshot_webview`, and the rest of the webview toolset. That is the whole
point of §1.

## Consequences

**Better.** MCP agents can lay out a workspace: open a terminal beside a
browser, point the browser at the dev server, screenshot it. `split_pane` +
`new_browser` returning `paneId` closes the loop with the 11 existing webview
tools without a `list_webviews` poll. `list_panes` gives agents the layout
introspection that `list_webviews` only half-covered. The correlated channel is
reusable — `focus_workspace`, `merge_workspace`, and `get_agent_status`, all
deferred by ADR-110, become table entries. Fixing `splitPaneAt`'s dropped `url`
fixes the in-app "split with → Browser" path too.

**Harder.** Two IPC semantics now coexist on one channel (fire-and-forget when
`requestId` is absent, request/response when present). This is deliberate —
`start_agent` genuinely cannot report success — but it is a footgun, and the
`AppCommand` type must make the distinction legible. Every new renderer-owned
command must decide which it is.

**Risks.**
- *Timeout tuning.* 5s is generous for a zustand `set()` but the renderer may be
  mid-startup. Handlers are synchronous store writes, so the real failure mode
  is "no renderer listening," which the window check already catches. A
  rejected timeout must clear its `Map` entry.
- *A `paneId` is returned before the pane mounts.* `new_browser` resolves once
  the store updates; the `<webview>` registers its `webContentsId` a tick later
  (`webview:register`). An agent that immediately calls `screenshot_webview`
  will race. Mitigation: the webview routes already 404 on an unregistered
  pane — document the retry in the tool description rather than blocking on
  mount, which would couple main to renderer render timing.
- *Scope creep in `control-server.ts`.* It absorbed `/projects` and `/agents` in
  ADR-145 to keep `webview-server.ts` under 1000 lines. Adding `/panes` and
  `/tabs` pushes it toward the same cliff. Accepted for now; the natural next
  split is `control-server.ts` → `routes-projects.ts` / `routes-panes.ts`, which
  this ADR does not do.
- *`splitPaneAt` signature length.* Seven positional params is past the point an
  options object is warranted. Ticket 2 converts the trailing three to an
  options bag rather than growing the list.

**Not doing.** Panel (editor-group) splits — `splitPanel`, `splitPanelWithTab`.
They are a second tree with the same shape, and nothing in the MCP surface needs
cross-tab layout yet. Diff and task pane types are reachable through
`split_pane`'s `contentType` but get no dedicated tool.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
