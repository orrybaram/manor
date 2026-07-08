---
title: resolveContext helper, optional projectId, current_workspace tool
status: todo
priority: high
assignee: opus
blocked_by: [2]
---

# `resolveContext` helper, optional `projectId`, `current_workspace` tool

Consume the `GET /context` route from ticket 2. This is where the ergonomics land: an agent
can now call `list_issues({})` and get its own project's issues.

## ⚠ Boundary

The MCP server is a **standalone Node process** (`electron/mcp-webview-server.ts`), launched
over stdio by Claude Code. It must not import from `electron/linear.ts`, `electron/github.ts`,
`electron/persistence.ts`, `electron/pane-context.ts`, or
`electron/terminal-host/layout-persistence.ts`. It does **not** learn the `PersistedLayout`
schema and does **not** read `~/.manor/layout.json` — main owns that. Declare response shapes
inline with local interfaces, as the existing handlers do.

Reading `process.env` and `process.cwd()` is fine — `mcp-webview-server.ts:35` already reads
`process.env.MANOR_WEBVIEW_PORT`.

ADR-149 is concurrently adding `electron/mcp/tools-panes.ts` and registering it in the
`modules` array. Do not touch that array; your new tool lives in the existing
`tools-projects.ts` module. Stage only your own files.

## 1. `electron/mcp/context.ts` — new

Model it directly on `resolvePaneId` (`electron/mcp/tools-webview.ts:16-32`): explicit
argument wins, otherwise resolve, otherwise throw an error that *enumerates candidates* so
the model can retry.

```ts
import type { Http } from "./types";

export interface CallerContext {
  projectId: string;
  projectName: string;
  projectPath: string;
  workspacePath: string;
  branch: string;
  isMain: boolean;
  sources: string[];
  resolvedBy: "paneId" | "cwd";
}

export async function resolveContext(http: Http): Promise<CallerContext>;
export async function resolveProjectId(
  http: Http,
  projectId?: string,
): Promise<string>;
```

- `resolveContext` builds a querystring from `process.env.MANOR_PANE_ID` (omit when unset)
  and `process.cwd()`, then `http.get(\`/context?${qs}\`)`.
- `resolveProjectId(http, id)` returns `id` immediately when truthy; else
  `(await resolveContext(http)).projectId`.
- **404 handling.** Check how `http.get` surfaces a non-2xx today (read the `Http`
  implementation in `electron/mcp-webview-server.ts`). The route's 404 body carries
  `{ error, candidates: [{projectId, name, path}] }`. Turn that into a thrown `Error` whose
  message is the `error` string followed by an indented candidate listing, e.g.

  ```
  Could not determine the current project. Pass projectId explicitly.
    - abc123: manor (/Users/orry/Code/manor)
    - def456: tango (/Users/orry/Code/tango)
  ```

  If the existing `Http` already throws on non-2xx and discards the body, say so in your
  report and adapt — do not silently lose the candidate list; it is the whole point of the
  404 shape.

## 2. `projectId` becomes optional

In `electron/mcp/tools-projects.ts` and `electron/mcp/tools-agents.ts`, for each of:

`get_project`, `create_workspace`, `list_workspaces`, `remove_workspace`,
`list_issues`, `get_issue_detail`, `start_agent`, `batch_create_workspaces`

- Remove `"projectId"` from the schema's `required` array (drop `required` entirely if it
  becomes empty; keep the other required fields — e.g. `get_issue_detail` still requires
  `issue`, `batch_create_workspaces` still requires `issues`).
- Change the `projectId` property description to
  `"Project ID. Defaults to the project this agent is running in."`
- First line of each handler becomes:
  ```ts
  const projectId = await resolveProjectId(http, args.projectId as string | undefined);
  ```
  replacing the current `const projectId = args.projectId as string;`.

`add_project` and `list_projects` take no `projectId` — leave them alone. `start_agent`
also takes a required `workspacePath`; leave that required.

## 3. `current_workspace` tool — new

Append to `tools-projects.ts`. No arguments.

```ts
{
  name: "current_workspace",
  description:
    "Identify the Manor project and workspace this agent is running in, and which issue sources are available.",
  inputSchema: { type: "object" as const, properties: {} },
}
```

Handler renders the `CallerContext`:

```
manor (project abc123)
  path: /Users/orry/Code/manor
  workspace: /Users/orry/Code/manor
  branch: main (main workspace)
  issue sources: github, linear
```

- `branch` line: append `" (main workspace)"` when `isMain`, else nothing.
- `issue sources:` renders `sources.join(", ")`, or `"none configured"` when the array is
  empty. Do not omit the line — an agent needs to see the absence.
- Do not print `resolvedBy`; it is diagnostic, not something the model should condition on.

## Files to touch

- `electron/mcp/context.ts` — new; the two helpers above.
- `electron/mcp/tools-projects.ts` — optional `projectId` on its four tools; new
  `current_workspace` `ToolDef` + handler. Both arrays are picked up automatically by
  `mcp-webview-server.ts`; no registration change needed.
- `electron/mcp/tools-agents.ts` — optional `projectId` on its four tools.

## Checks

- `pnpm exec tsc --noEmit -p tsconfig.electron.json` — ~31 pre-existing errors; add none.
- `pnpm exec vitest run electron/` — existing suites must pass. Do not add tests; ticket 4
  owns that.
- `pnpm exec eslint` on each file you touched.

## Commit

Stage only your three files, by name.

  git commit -m "feat(adr-150): resolveContext helper, optional projectId, current_workspace tool"

No `Co-Authored-By` trailer.
