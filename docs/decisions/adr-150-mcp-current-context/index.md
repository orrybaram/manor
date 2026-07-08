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

# ADR-150: MCP knows which workspace it was called from

## Context

Every Manor MCP tool takes an explicit `projectId`. There is no cwd→project
resolution anywhere in `electron/mcp/`. An agent running inside a Manor workspace
cannot name the project it is sitting in, so it must either be told the id or guess.

ADR-148 made this worse in a specific, quiet way. `list_issues` defaults to
`source: "github"`. On a Linear-only project, `gh issue list` finds nothing, and
`GitHubManager.getMyIssues` *swallows the error and returns `[]`*
(`github.ts:167-193`). The agent reads **"No issues found."** and concludes the backlog
is empty. It never learns Linear exists. A default that fails loudly would be fine; this
one fails silently.

The signal to fix it already exists and nothing reads it. Manor injects
`MANOR_PANE_ID` into every agent PTY (`terminal-host/session.ts:231` for the daemon path,
`pty.ts:27` for the direct-pty fallback). The MCP server inherits it: `env: {}` in
`~/.claude.json` (`agent-connectors.ts:180-185`) is *additive*, not a replacement —
proven by `mcp-webview-server.ts:35` already reading `process.env.MANOR_WEBVIEW_PORT`
successfully. There is precedent for a plain-Node child of the agent consuming it:
`scripts/agent-hook.js:157`.

Verified live on a real session: `MANOR_PANE_ID=pane-5d04a8ae-…` resolves through
`~/.manor/layout.json` (v2) to `workspacePath: /Users/orrybaram/Code/manor`.

Three candidate signals, and why only one is right:

| Signal | Verdict |
| --- | --- |
| `MANOR_PANE_ID` → `layout.json` | **Correct.** Identifies the *caller's pane*. Immune to what the user is looking at. |
| `process.cwd()` | Usable fallback. PTYs launch with `cwd = workspacePath` (`ipc/pty.ts:42`), but a `cd` before `claude` breaks it. |
| `selectedProjectIndex` / `selectedWorkspaceIndex` | **Wrong.** Tracks the user's focus, not the agent's pane. A background agent in workspace A while the user views workspace B gets the wrong answer. Also never serialized over HTTP. |

## Decision

Add a single `GET /context` route that answers "who is calling me", and a
`resolveContext()` helper in the MCP process that mirrors the existing `resolvePaneId`
ladder (`tools-webview.ts:16-32`). Then make `projectId` optional everywhere.

### 1. A pure resolver: `electron/pane-context.ts`

No Electron imports, no I/O. Two functions over data handed in:

```ts
export function findWorkspaceForPane(
  layout: PersistedLayout,
  paneId: string,
): string | null;   // → workspacePath

export function matchProjectByPath(
  projects: ProjectInfo[],
  somePath: string,
): { project: ProjectInfo; workspace: WorkspaceInfo } | null;
```

`findWorkspaceForPane` walks `layout.workspaces[] → panels{} → tabs[] → paneSessions{}`
and returns the `workspacePath` whose `paneSessions` contains `paneId` as a key
(`layout-persistence.ts:96-99`; `app-store.ts:2698` writes the paneId as both key and
`daemonSessionId`).

`matchProjectByPath` finds the workspace whose `path` is the **longest prefix** of
`somePath` — longest, because a worktree may live inside the main repo path, and the
main workspace's `path` is a prefix of everything. Exact match wins outright.

### 2. `GET /context` on the control server

```
GET /context?paneId=…&cwd=…
```

Both params optional. Resolution ladder, in order:

1. `paneId` → `layoutPersistence.load()` → `findWorkspaceForPane` → `matchProjectByPath`
2. `cwd` → `matchProjectByPath` directly
3. neither resolves → `404` with a body listing candidate projects, so the model can
   retry with an explicit `projectId` — matching how `resolvePaneId` errors on ambiguity.

Response:

```json
{
  "projectId": "…",
  "projectName": "manor",
  "projectPath": "/Users/orrybaram/Code/manor",
  "workspacePath": "/Users/orrybaram/Code/manor",
  "branch": "main",
  "isMain": true,
  "sources": ["github", "linear"],
  "resolvedBy": "paneId"
}
```

`sources` reports what is *actually usable*, computed in main:

- `"github"` when `deps.githubManager` is non-null.
- `"linear"` when `deps.linearManager?.isConnected()` **and**
  `project.linearAssociations.length > 0`. Both conditions — a connected account with no
  team associated on this project cannot answer a query.

`ControlDeps` gains `layoutPersistence`. `WebviewServer` and `createWebviewServer` gain a
matching optional param, following exactly the `linearManager` thread from ADR-148.

**`GET /context`, not `GET /panes/:id/context`.** ADR-149 is concurrently claiming the
`/panes` namespace and restructuring `handleControlRequest`'s segment dispatch (its
ticket 4). A top-level `context` branch, placed beside the existing `agents` branch,
touches none of that. It is also the honest name: the route answers a question about the
*caller*, not about a pane.

### 3. `resolveContext()` in the MCP process

New `electron/mcp/context.ts`:

```ts
export interface CallerContext { projectId: string; projectName: string;
  projectPath: string; workspacePath: string; branch: string;
  isMain: boolean; sources: string[]; resolvedBy: "paneId" | "cwd"; }

export async function resolveContext(http: Http): Promise<CallerContext>;
export async function resolveProjectId(http: Http, projectId?: string): Promise<string>;
```

`resolveContext` sends `process.env.MANOR_PANE_ID` and `process.cwd()` as query params and
returns the parsed body; a 404 surfaces as a thrown `Error` carrying the candidate listing.
`resolveProjectId` short-circuits on an explicit id — the `resolvePaneId` shape exactly.

The MCP process stays Electron-free and stays a thin HTTP proxy: it does **not** learn the
`PersistedLayout` schema, and it does **not** read `layout.json`. Main already owns that
format (`layoutPersistence.load()`, wired through `IpcDeps`) and can do the
`workspacePath → project` lookup in the same hop, which the MCP process would otherwise
need a second round trip for.

### 4. `projectId` becomes optional; one new tool

`projectId` moves out of `required` and gains
`"Defaults to the project this agent is running in."` on:

`get_project`, `create_workspace`, `list_workspaces`, `remove_workspace`,
`list_issues`, `get_issue_detail`, `start_agent`, `batch_create_workspaces`.

Each handler's first line becomes
`const projectId = await resolveProjectId(http, args.projectId as string | undefined);`

New `current_workspace` tool — no arguments — rendering the context, including the
`sources` line. This is what lets an agent discover that Linear is available at all.

**`source` on `list_issues` stays explicit and stays defaulted to `"github"`.** This ADR
gives the agent the information to choose; it does not choose for it. Auto-detection was
considered and rejected when ADR-148 was scoped, and nothing here changes that reasoning —
it would be ambiguous for a project configured with both.

## Consequences

**Better**

- The silent-empty-backlog failure from ADR-148 becomes discoverable: `current_workspace`
  reports `sources: ["linear"]`, and the agent asks for the right source.
- `MANOR_PANE_ID` is authoritative for the *caller*, so a background agent in one workspace
  and a user browsing another both get correct, different answers.
- Every project tool gets shorter to call. `list_issues({})` becomes meaningful.

**Worse / riskier**

- **One extra HTTP round trip per tool call** when `projectId` is omitted. Deliberately
  uncached: the resolution is a localhost GET plus a small file read, and caching it for the
  process lifetime would go stale if the project is removed or renamed mid-session. If this
  ever shows up in a profile, cache on `paneId` with a short TTL.
- **`layout.json` lags.** It is written on a 500ms debounce and `flushLayoutSave` serializes
  only the *active* workspace (`app-store.ts:2674-2676`). A brand-new pane in a non-active
  workspace can be missing from the file. The `cwd` fallback covers exactly this case, which
  is why the ladder has two rungs and not one.
- **Agents launched outside a Manor pane** have no `MANOR_PANE_ID`. They fall to `cwd`, then
  to a 404 listing candidates. Acceptable — that is strictly more than they get today.
- `ControlDeps` grows a fourth dependency. It is now `{ projectManager, githubManager,
  linearManager, layoutPersistence }`. A fifth would justify a container object.
- **Concurrent edit hazard.** ADR-149 is mid-flight in `control-server.ts`,
  `webview-server.ts`, and `mcp-webview-server.ts`. Ticket 2 here adds one additive branch
  and a deps field; it must be rebased on whatever ADR-149 has landed, not merged blindly.

**Explicitly not done**

- No `MANOR_WORKSPACE` / `MANOR_PROJECT_ID` env var. `MANOR_PANE_ID` already exists and is
  the finer-grained key; adding a second, redundant, staleness-prone var to every PTY is
  worse than one file read.
- `selectedProjectIndex` / `selectedWorkspaceIndex` remain renderer-focus state and remain
  unexposed over HTTP.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
