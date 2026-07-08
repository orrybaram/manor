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

# ADR-145: Decompose the MCP Server & Move Orchestration to the Canonical Layer

## Context

A thermo-nuclear code-quality review of the ADR-110 + ADR-144 branch surfaced
structural debt introduced while shipping the `manor` MCP tools. This ADR is
purely a **behavior-preserving refactor** — no new features, no behavior change.
The 28 existing MCP tests plus `pnpm build` are the acceptance gate.

### Findings being addressed

1. **`electron/webview-server.ts` crossed 1000 lines (698 → 1010)** and
   `WebviewServer` became a god-object: webview inspection + project CRUD +
   workspace CRUD + GitHub issues + batch fan-out + agent launching, all in a
   file named for one of those six concerns.
2. **Batch orchestration leaked into the HTTP transport layer.** The ~100-line
   issue→worktree→assign→launch loop lives inline in `handleProjectRequest`,
   reaching across `GitHubManager`, `ProjectManager`, and the renderer bridge.
3. **A "diff the workspace list to find the path I just created" hack** — because
   `createWorktree` returns a whole `ProjectInfo`, the batch code snapshots
   workspace paths before/after and set-diffs to recover the new path that
   `createWorktree` already computed deterministically.
4. **Routing is a nested-optional mega-regex + boolean ladder** that will rot as
   sub-resources are added.
5. **`electron/mcp-webview-server.ts` (901 lines)** is one giant `TOOLS` array +
   one giant `handleTool` switch that both grow with every tool.
6. Nits: batch swallows `startAgent`'s failure reason; the `app-command` payload
   type is duplicated 3×.

### Constraints discovered

- `ProjectManager.createWorktree` is exposed over IPC (`projects:createWorktree`)
  and the renderer store depends on its `ProjectInfo` return — **its public
  signature must not change.** Finding 3 is therefore fixed by extracting a
  shared private path helper, not by altering the return type.
- Existing tests exercise the **HTTP endpoints** (real server + fetch), so the
  extraction in Finding 1 is transparent to them. The batch tests assert on
  `pm.createWorktree`; moving that loop to a new canonical method (Finding 2)
  moves those assertions to the new boundary.

## Decision

### 1. Canonical layer owns the worktree fan-out (`electron/persistence.ts`)

- Extract a private `worktreePathFor(project, name): string` from the inline path
  logic in `createWorktree`; `createWorktree` now uses it (single source of
  truth for the deterministic worktree path). **No public signature change.**
- Add `createWorkspacesFromIssues(projectId, issues: IssueSeed[], baseBranch?):
  Promise<WorkspaceFromIssue[]>` where `IssueSeed = { number, title, url, body? }`.
  It loops **sequentially** (git worktree creation must not run concurrently on
  one repo), builds the `LinkedIssue`, resolves the path via `worktreePathFor`
  (killing the set-diff hack), calls `createWorktree`, and isolates per-issue
  errors. It takes pre-fetched issue seeds so `ProjectManager` stays free of any
  `GitHubManager` dependency.

### 2. Extract the Manor-control HTTP API (`electron/control-server.ts`)

- New module owns `/projects…` and `/agents`: `handleControlRequest(deps,
  method, url, json, readBody): Promise<boolean>` (returns whether it handled the
  route) and `startAgent(workspacePath, prompt?)` (the renderer bridge). `deps`
  is `{ projectManager, githubManager }`.
- Dispatch on `pathname.split("/")` segments (Finding 4) instead of the
  nested-optional regex.
- The batch route becomes a thin adapter: fetch issue details **in parallel**
  (independent `gh` reads), hand the seeds to
  `pm.createWorkspacesFromIssues` (sequential git), then in a second pass do the
  `assign` writes + prompt-templating + `startAgent` launches, surfacing
  `startAgent`'s error into each result (Finding 6).
- `WebviewServer` keeps only webview routes and delegates:
  `if (await handleControlRequest(this.controlDeps, …)) return;`. This drops the
  file back under 1000 lines and restores its cohesion.

### 3. Split MCP tool definitions by domain (`electron/mcp/`)

- `electron/mcp/types.ts` — shared `ToolModule` / `Http` / `ToolResult` types.
- `electron/mcp/tools-webview.ts`, `tools-projects.ts`, `tools-agents.ts` — each
  exports `{ tools, handlers }` for its domain.
- `mcp-webview-server.ts` becomes a thin entry: port discovery + an `http`
  client + compose the modules (`flatMap` tools, merge handler maps) + wire the
  MCP `Server`.

### 4. Nits

- Share the `app-command` payload type (`AppCommand`) across preload,
  `electron.d.ts`, and `App.tsx`.
- Thread `startAgent().error` into batch results.

## Consequences

**Better:** `webview-server.ts` back under 1k and cohesive; the fan-out is a
unit-testable canonical method instead of inline transport code; the path-diff
hack is gone; adding future control routes (`focus_workspace`, `merge_workspace`)
is a table entry, not another regex alternation; the MCP tool file stops growing
monolithically.

**Harder / risk:** more files and one new canonical method — justified by the
size and testability wins, not thin wrappers. The batch tests must be retargeted
from `createWorktree` to `createWorkspacesFromIssues`, and a direct unit test for
the new canonical method is added. Because this is behavior-preserving, the
existing HTTP-level tests are the safety net at every step.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
