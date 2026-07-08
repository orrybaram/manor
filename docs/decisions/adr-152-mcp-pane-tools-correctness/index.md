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

# ADR-152: Pane-tool correctness, and the deletions ADR-148–151 set up

## Context

A deep quality audit of the ADR-148/149/150/151 branch (35 commits, 66 files,
8,266 insertions) found seven user-visible correctness bugs and a consistent
structural pattern: **each ADR correctly identified an abstraction, then
declined to delete what that abstraction made redundant.** Net non-test lines
went 775 → 1048 across the control-server decomposition — roughly break-even on
concepts.

### The correctness bugs

1. **`list_panes` lies about focus.** `getLayoutSnapshot` (`app-store.ts:2551`)
   iterates every panel and sets `active: tab.id === panel.selectedTabId`
   *per panel*, and `flattenPaneTree` sets `focused` from `tab.focusedPaneId`
   *per tab*. A single-panel workspace with three tabs prints `[focused]` on
   **three** panes. `TabSnapshot` carries no `panelId`, so the model cannot
   disambiguate. This is the one tool whose entire job is orientation.

2. **One paneId, three scopes.** `list_panes` reports all panels;
   `focus_pane` accepts any panel (`layoutHasPane`); `split_pane` and
   `close_pane` accept only the *active* panel (`panelHasPane`). `close_pane`
   returns `400 Unknown paneId` for a pane `list_panes` just printed.

3. **Pane tools target the user's focus, not the caller's pane.** ADR-150
   explicitly rejected renderer-focus state ("Tracks the user's focus, not the
   agent's pane"), yet `split_pane`/`new_terminal`/`new_browser` resolve against
   `activeWorkspacePath`. `MANOR_PANE_ID` identifies the caller and is already
   read by `mcp/context.ts:37` — the pane tools never send it. A background
   agent in workspace B splits a pane in workspace A.

4. **`new_tab` writes before it validates.** `app-commands.ts:214` calls
   `setActiveWorkspace` before parsing `contentType`/`url`/`background`. A
   rejected request leaves the user in a different workspace. The module's own
   docstring promises the opposite. It also never restores the prior workspace,
   so any cross-workspace tab creation hijacks the foreground — which
   `background: true` explicitly promises not to do.

5. **`get_issue_detail` is broken for GitHub.** `list_issues` prints `ref` =
   `"#42"`; feeding it back yields `Number.parseInt("#42")` → `NaN` → 400.
   `McpIssue.id` — the field designed to be that lookup key — is dead code, and
   `issue-sources.ts` is imported by zero files under `electron/mcp/`, so
   ADR-148's "exactly one issue shape on the wire" is false: `tools-agents.ts`
   re-declares it as an inline cast.

6. **`availableSources` always advertises `"github"`.** `githubManager` is
   constructed unconditionally (`app-lifecycle.ts:141`), so the 503 branch is
   unreachable and `checkStatus()` is never consulted. With no `gh` installed,
   `current_workspace` reports "issue sources: github" and `list_issues` 502s.

7. **The swallow-fix moved the swallow.** `40ecb20` unswallowed
   `getMyIssues`/`getAllIssues`, but `assignIssue` and `closeIssue`
   (`github.ts:241-271`) still `catch {}`. `closeIssue` is not fire-and-forget:
   `LinkedIssuesPopover.tsx:286` optimistically removes the row before awaiting,
   so a failed close leaves the UI asserting an issue is closed when it isn't.
   The `try/catch` at `projects.ts:239` wraps a method that cannot throw.

### The declined deletions

- `rendererErrorStatus` (`renderer-bridge.ts:127`) reconstructs an HTTP status by
  string-comparing error prose it produced 20 lines earlier — one commit after
  `5767b54` ("Typed HttpError; delete regex error-message parsing") deleted this
  exact pattern. It is exported and re-exported for one same-file call site.
- `routes/panes.ts:29-34,66-78` validates `direction`/`contentType`/`browser⇒url`,
  which `app-commands.ts` already validates — strictly more weakly, and both
  paths yield 400.
- `control-server.ts` is a barrel: 8 of 11 exports have zero consumers, and
  `handleControlRequest` is a 5-param pass-through to `dispatch`.
- `resolvedBy` (`routes/context.ts:21`) is written twice, read never. Strip it
  and `resolveByCwd` *is* `matchProjectByPath`.
- `getLayoutSnapshot` is a selector wearing an action's clothes, added to a
  2757-line store. ADR-149 §107 specified a selector in `pane-tree.ts`.
  `flattenPaneTree` re-derives `allPaneIds`'s traversal with four positional
  params, widening `paneContentType` to `Record<string,string>` only to cast it
  back — the store already types it as the exact union.
- `newPaneId` was exported so `app-commands.ts` could pre-mint an ID, threading
  an optional `paneId` through four store signatures, then reading the ID *back
  out of the tree* via `findTabIdForPane` after the `set()`.

## Decision

Fix the seven bugs and make the six deletions, in dependency order. Behavior
changes are confined to the bug fixes; the deletions are behavior-preserving.

### Snapshot types get one home

`PaneSnapshot`/`TabSnapshot`/`LayoutSnapshot` are declared twice — once in
`src/store/pane-tree.ts` + `src/store/app-store.ts`, once in
`electron/mcp/tools-panes.ts` under a `// mirrors` comment. `electron/` already
imports types from `src/` (`github.ts:7`), and a type-only import is erased at
runtime, so the MCP process stays Electron-free. All three move to
`src/store/layout-snapshot.ts` alongside the selector.

### The snapshot carries one truth

Drop per-tab `active`/`focused` booleans. `LayoutSnapshot` gains top-level
`activeTabId` and `focusedPaneId`, computed from
`layout.panels[layout.activePanelId]`. `formatLayoutSnapshot` compares against
those. Fewer fields, one source of truth, and the model can no longer be told
three panes are focused.

### One scope for paneIds

`focusPane` already searches all panels (`app-store.ts:1850`) using the
canonical `findPanelWithPane` helper. `closePaneById` and `splitPaneAt` adopt
the same lookup. `panelHasPane` and both `requireActivePanel` calls in the
handlers are deleted; `layoutHasPane` becomes the single scope.

### Store actions return what they mint

`addTab`, `addTerminalTab`, `addBrowserTab`, and `splitPaneAt` return the IDs
they create (`{ tabId, paneId }` / `paneId`). This deletes the `newPaneId`
export, three of four optional `paneId` params, and `findTabIdForPane` — and is a
prerequisite for `new_tab` restoring the prior workspace, since the tabId can no
longer be read back out of a layout the user is no longer looking at.

**Correction (found during ticket 2).** This ADR originally claimed the optional
`paneId` param existed *purely* so `app-commands.ts` could pre-mint. That is true
of the `newPaneId` **export**, but not of `addTab`'s param: `App.tsx:532` calls
`addTab(prewarmed?.paneId)`, and `prewarm-manager.ts:32` has already spawned a PTY
under that id and injected the agent command (`:65`). The new pane must adopt it or
the warm session is orphaned and the terminal cold-starts. `addTab` therefore keeps
the param, renamed `adoptPaneId` and documented for its one real consumer. Deleting
it would have been a silent performance regression, not a behavior-preserving
deletion.

Ticket 2 also had to widen `closeTab` alongside `closePaneById`: the latter
delegates to the former when the pane is the last in its tab, so a non-active
panel's single-pane tab would otherwise still no-op — the most common
`close_pane` case.

### `new_tab` never moves the user

Parse every argument first, then switch, create, and switch back. `new-tab` is
reachable only from MCP, so restoring is always correct: an agent that wants the
user to look at its tab calls `focus_pane`. `background` is rejected for
`contentType: "terminal"` (the store has no such option), and `url` is rejected
for non-browser panes.

### Pane tools resolve the caller's context

`mcp/tools-panes.ts` defaults `paneId` to `process.env.MANOR_PANE_ID` and
`workspacePath` to `(await resolveContext(http)).workspacePath` — exactly what
ADR-150's `/context` route exists for.

### Typed transport failures

```ts
export type RendererResponse<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "unavailable" | "handler"; error: string };
```

`requestRenderer` stamps `kind` at the two sites that already know it.
`rendererErrorStatus` collapses into `proxyToRenderer` and disappears, along
with `error: string | undefined` and the `json(400, { error: undefined })` case.
The duplicated validation in `routes/panes.ts` goes with it: `app-commands.ts`
is the layer that knows the store's constraints, and a handler throw already
maps to 400.

### `control-server.ts` ceases to exist

The route table and `OWNED_PREFIXES` (derived from the table, not hand-listed)
move to `routes/index.ts`. `renderer-bridge.ts` moves up to
`electron/renderer-bridge.ts` — it is not a route, and the cycle it cites in its
own header exists only because the table lived in `control-server.ts`.
`webview-server.ts`, `preload.ts`, and the tests import directly.

### Issue refs round-trip

`McpIssue.id` is deleted. `githubBackend.detail` strips a leading `#` and
validates with `/^\d+$/` (`Number.parseInt("42abc")` currently yields `42`).
`tools-agents.ts` imports `McpIssue`/`McpIssueDetail` type-only from
`issue-sources.ts` and deletes both inline cast shapes. `InvalidIssueRef`
becomes a contract of `IssueBackend.detail`, so `linearBackend` rejects
malformed refs with 400 rather than letting the SDK throw into a 502.

### Readiness is asked, not assumed

`GitHubManager` gains a memoized `isReady()` wrapping `checkStatus()`.
`availableSources` and `issueBackend` become async and consult it, so the
advertised source list and the serving list still cannot disagree — the property
`linearReadiness` already guarantees for Linear.

### Failures surface

The `try/catch` blocks in `github.ts`'s `assignIssue`/`closeIssue` are deleted.
`LinkedIssuesPopover` reverts its optimistic removal on rejection;
`GitHubIssueDetailView` surfaces the error rather than closing the dialog.
`BatchResultEntry` gains `assignError`, and the batch route's assign calls —
independent network writes — move into the existing `Promise.all`.

## Consequences

**Better.** Seven bugs gone, including two that make `list_panes` — the join key
for every other pane tool — actively misleading. The MCP tool surface stops
depending on where the user happens to be looking. Roughly 150 lines of
duplicated validation, dead exports, dead fields, and hand-rolled traversal are
deleted rather than rearranged. `app-store.ts` shrinks. One declaration each for
the snapshot types and the issue shape, so cross-process drift stops being
expressible.

**Harder.** `availableSources`/`issueBackend` become async, rippling to two route
handlers. `isReady()` memoizes, so a user who installs `gh` mid-session must
restart Manor before `list_issues` sees it — acceptable, and no worse than the
current always-advertise behavior. Making `closeIssue` throw means two UI call
sites must handle rejection; a third (`linear.ts:293`) swallows symmetrically and
is left for follow-up rather than widening this ADR.

**Risk.** Widening `closePaneById`/`splitPaneAt` to all panels is a real behavior
change for in-app callers, not just MCP: closing a pane in a non-active panel
now works where it previously no-opped. This matches `focusPane`'s existing
semantics and is what users would expect, but it is the one change here that a
human should eyeball. `movePaneToTarget` already uses `findPanelWithPane`, so
the helper is canonical, not new.

**Deferred.** The typed tool registry (replacing `ToolModule`'s `Object.assign`
parity trap), server-side context resolution (deleting `resolveProjectId` and its
8 call sites plus 2N `git worktree list` spawns per tool call), the `pick()`
helper for 27 lines of arg-sieve boilerplate, and splitting the 1821-line
`mcp-webview-server.test.ts`. Each is a clean, separable win; none is required to
make this branch correct.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
