---
type: adr
status: accepted
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

# ADR-148: Read Linear issues via MCP

## Context

Manor already talks to Linear. `LinearManager` (`electron/linear.ts`) speaks GraphQL to
`api.linear.app`, stores its API key encrypted via Electron `safeStorage`
(`~/Library/Application Support/Manor/linear-token.enc`), and exposes
`getMyIssues` / `getAllIssues` / `getIssueDetail` over IPC to the renderer
(`electron/ipc/integrations.ts:75-171`). The command palette renders them
(`src/components/command-palette/LinearIssuesView.tsx`).

None of this is reachable from an agent. Manor's MCP server exposes exactly one
issue tool — `list_issues` — and it is hardwired to GitHub:

```
mcp/tools-agents.ts  →  HTTP GET /projects/:id/issues
                     →  control-server.ts:142
                     →  GitHubManager.getMyIssues()  →  `gh issue list`
```

`ControlDeps` (`control-server.ts:14`) carries only `{ projectManager, githubManager }`.
`LinearManager` is constructed in `app-lifecycle.ts:142` and handed to `ipcDeps`, but
`webviewIpc.createWebviewServer(projectManager, githubManager)` (`app-lifecycle.ts:206`)
never receives it. So an agent working in a Manor workspace can list GitHub issues and
cannot see Linear at all — even for a project that has `linearAssociations` configured.

Two constraints shape the fix:

1. **The MCP server is Electron-free.** `electron/mcp-webview-server.ts` is a standalone
   Node process launched by Claude Code over stdio. It cannot import `LinearManager`,
   because `linear.ts:3` imports `safeStorage` from `electron`. Everything Linear must
   stay behind the HTTP control-server boundary, exactly as `GitHubManager` does.

2. **The two issue shapes do not unify for free.** GitHub keys on a numeric `number` and
   scopes by `repoPath`; Linear keys on a string `identifier` (`ENG-123`) and scopes by
   `teamIds` from `project.linearAssociations`. `state` is a bare string on GitHub and a
   `{ name, type }` object on Linear. `control-server.ts` and `tools-agents.ts` both type
   directly against the GitHub shape today.

Separately, `get_issue_detail` does not exist as an MCP tool for *either* source. An agent
can see an issue title but never its body. Reading Linear issues without reading their
descriptions is not useful, so this ADR adds detail for both sources rather than shipping
a listing-only Linear tool and a follow-up.

## Decision

Introduce a normalized issue shape at the control-server boundary, and route on an
explicit `source` parameter.

### 1. A normalization module: `electron/issue-sources.ts`

New pure module — no Electron imports, no I/O. It owns the two things that currently
have no home: the cross-source issue shape, and the state-vocabulary translation.

```ts
export type IssueSource = "github" | "linear";
export type IssueState = "open" | "closed" | "all";

export interface McpIssue {
  source: IssueSource;
  /** Lookup key for get_issue_detail: "42" | "ENG-123". */
  id: string;
  /** Display ref: "#42" | "ENG-123". */
  ref: string;
  title: string;
  url: string;
  state: string;
  labels: string[];
}

export interface McpIssueDetail extends McpIssue {
  body: string | null;
  assignees: string[];
}

export function normalizeGitHubIssue(i: GitHubIssue): McpIssue;
export function normalizeLinearIssue(i: LinearIssue): McpIssue;
export function normalizeGitHubIssueDetail(i: GitHubIssueDetail): McpIssueDetail;
export function normalizeLinearIssueDetail(i: LinearIssueDetail): McpIssueDetail;

/** GitHub's open/closed/all → Linear workflow state types. */
export function linearStateTypes(state: IssueState): string[];
```

`linearStateTypes` maps:

| `state`  | Linear `stateTypes`                                            |
| -------- | -------------------------------------------------------------- |
| `open`   | `["triage", "backlog", "unstarted", "started"]`                  |
| `closed` | `["completed", "canceled"]`                                      |
| `all`    | all six                                                          |

The GitHub `ref` keeps its leading `#`, so the existing `list_issues` text output is
byte-for-byte unchanged for GitHub callers. This is a pure additive change from the
agent's point of view.

Types are imported with `import type` from `./github` and `./linear` — type-only, so no
`safeStorage` reaches the pure module or its tests.

### 2. Thread `LinearManager` to the control server

- `ControlDeps` gains `linearManager: LinearManager | null`.
- `WebviewServer`'s constructor gains a fourth optional `linearManager` param, stored and
  passed into `handleControlRequest`'s deps object (`webview-server.ts:232`).
- `createWebviewServer` (`electron/ipc/webview.ts:34`) gains the same param.
- `app-lifecycle.ts:206` passes the already-constructed `linearManager`.

Nothing about `safeStorage` crosses the process boundary; the MCP server still only speaks
HTTP.

### 3. Control-server routes

`GET /projects/:id/issues?source=…&filter=…&state=…&limit=…`

- `source` defaults to `"github"`. Unknown values → 400.
- `source=github` → unchanged behavior, mapped through `normalizeGitHubIssue`.
- `source=linear`:
  - 503 if `deps.linearManager` is null or `!linearManager.isConnected()`, with the message
    `"Linear is not connected. Connect Linear in Manor settings."`
  - 400 if `project.linearAssociations` is empty, with the message
    `"Project has no Linear team associated."` — this is a configuration problem, not a
    missing capability, and the two deserve different messages.
  - Otherwise `teamIds = project.linearAssociations.map(a => a.teamId)`, then
    `filter === "all" ? getAllIssues(teamIds, opts) : getMyIssues(teamIds, opts)` where
    `opts = { stateTypes: linearStateTypes(state), limit }`.

`GET /projects/:id/issues/:issueRef?source=…` — new route, `subsub` slot in the existing
segment parse (`control-server.ts:111`).

- `source=github` → `issueRef` must parse as a positive integer, else 400.
  `github.getIssueDetail(project.path, n)`.
- `source=linear` → `issueRef` passed through verbatim. Linear's `issue(id:)` query resolves
  both a UUID and a human identifier like `ENG-123`, so the value the agent read out of
  `list_issues` round-trips without a lookup table.
- Both return `McpIssueDetail`.

`batch_create_workspaces` is **out of scope** and stays GitHub-only. Its
`issues: number[]` schema and the `"Work on GitHub issue #…"` template in `renderPrompt`
(`control-server.ts:56-67`) both assume numeric refs, and creating worktrees from Linear
issues needs a branch-naming decision (`LinearIssue.branchName` exists and is
Linear-flavored) that this ADR does not want to make. The route explicitly rejects
`source=linear` for now.

### 4. MCP tools

In `electron/mcp/tools-agents.ts`:

- `list_issues` gains an optional `source: "github" | "linear"` (default `"github"`).
  Description updated to mention both. The handler forwards `source` in the querystring
  and formats against `McpIssue`: `` `${ref} ${title}${labels}` ``.
- New `get_issue_detail` tool: `{ projectId, issue, source? }`. Renders ref, title, state,
  labels, url, assignees, then the body.

Both handlers stay dumb string-formatters over the normalized shape — the MCP process
learns nothing about Linear.

## Consequences

**Better**

- Agents can read Linear issues, and — new for both sources — issue bodies.
- The GitHub path is refactored *through* a normalizer rather than around one, so there is
  exactly one issue shape on the wire instead of two.
- `issue-sources.ts` is pure and unit-testable without mocking `electron`, which the
  existing `mcp-webview-server.test.ts` has to do.

**Worse / riskier**

- `list_issues` output for Linear reads `ENG-123 Title` while GitHub reads `#42 Title`.
  Agents must not assume a `#`-prefixed integer. Acceptable: the ref is opaque and feeds
  straight back into `get_issue_detail`.
- The open/closed → `stateTypes` mapping is lossy. A Linear issue in `triage` is reported
  as open; there is no GitHub analogue. Agents needing finer control get none.
- Linear's `getMyIssues`/`getAllIssues` accept `limit` but internally clamp `fetchLimit` to
  50 (`linear.ts:109`, `linear.ts:169`). A `limit > 50` silently returns at most 50. Not
  introduced here, but now reachable from MCP.
- `LinearManager.getMyIssues` throws on a bad token, whereas `GitHubManager.getMyIssues`
  swallows errors and returns `[]` (`github.ts:167-193`). The route must catch and 502 so
  an expired Linear key does not surface as an unhandled rejection in main.
- `ControlDeps` grows a third manager. A fourth source would justify an `IssueProvider`
  interface; two does not.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
