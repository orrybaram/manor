---
title: Add GET /context route and thread layoutPersistence
status: todo
priority: critical
assignee: opus
blocked_by: [1]
---

# Add `GET /context` route and thread `layoutPersistence`

Expose the caller-identification route. Uses `electron/pane-context.ts` from ticket 1.

## ⚠ Concurrent edits

ADR-149 is being implemented **in parallel** and touches `electron/control-server.ts`,
`electron/webview-server.ts`, and `electron/mcp-webview-server.ts`. Its ticket 4 adds a
`/panes` and `/tabs` segment branch and may restructure the dispatch in
`handleControlRequest`.

- **Read the current files from disk.** Do not trust line numbers below.
- Keep your change **additive**: one new top-level branch, one new `ControlDeps` field.
- Do **not** claim the `/panes` namespace. This route is top-level `/context`.
- If you find working-tree changes you did not make, do **not** commit them. Stage only
  your own files, by name. Never `git add -A`.

## Wiring

Follow the exact thread ADR-148 used for `linearManager`:

- `ControlDeps` gains `layoutPersistence: LayoutPersistence | null`.
- `WebviewServer` gains a private field + another optional constructor param (defaulted
  `null`), and passes it into the `handleControlRequest` deps literal.
- `createWebviewServer` (`electron/ipc/webview.ts`) gains a matching optional param.
- `app-lifecycle.ts` passes the `layoutPersistence` already constructed there
  (`new LayoutPersistence()`, ~line 135; also already in `ipcDeps`).

`import type { LayoutPersistence } from "./terminal-host/layout-persistence"`.
Its API: `load(): PersistedLayout | null`.

## The route

`handleControlRequest` currently early-returns `false` unless `segments[0]` is `"agents"`
or `"projects"`. Add a `segments[0] === "context"` branch **before** the
`if (segments[0] !== "projects") return false;` guard, beside the `agents` branch.

```
GET /context?paneId=…&cwd=…
```

Non-GET → `405`. Both query params optional. `503` if `deps.projectManager` is null,
matching the `/projects` guard.

Resolution ladder, in order — stop at the first that resolves:

1. **`paneId`** → `deps.layoutPersistence?.load()`. If the layout is non-null,
   `findWorkspaceForPane(layout, paneId)` → a `workspacePath`. Feed that into
   `matchProjectByPath(await pm.getProjects(), workspacePath)`. `resolvedBy: "paneId"`.
2. **`cwd`** → `matchProjectByPath(projects, cwd)` directly. `resolvedBy: "cwd"`.
3. Neither → `404` with a body the model can act on:
   ```json
   { "error": "Could not determine the current project. Pass projectId explicitly.",
     "candidates": [ { "projectId": "…", "name": "…", "path": "…" } ] }
   ```
   Build `candidates` from `pm.getProjects()`. This mirrors how `resolvePaneId`
   (`electron/mcp/tools-webview.ts:16-32`) errors on ambiguity — enumerate, don't guess.

Wrap `layoutPersistence.load()` in try/catch: a corrupt or partially-written
`~/.manor/layout.json` must fall through to the `cwd` rung, not 500. (It is written on a
debounce, so a torn read is possible.)

## Response

```json
{
  "projectId": "…", "projectName": "manor", "projectPath": "/Users/…/manor",
  "workspacePath": "/Users/…/manor", "branch": "main", "isMain": true,
  "sources": ["github", "linear"], "resolvedBy": "paneId"
}
```

`branch` / `isMain` come from the matched `WorkspaceInfo`.

`sources` is computed in main and reports what is **actually usable right now**:

- push `"github"` when `deps.githubManager` is non-null.
- push `"linear"` when **both** `deps.linearManager?.isConnected()` is true **and**
  `project.linearAssociations.length > 0`. A connected Linear account with no team
  associated on this project cannot answer a query, so it must not be advertised.
  Note `linearAssociations` is optional on the persisted project — treat absent as `[]`.

This is what lets an agent discover Linear exists. It does **not** change any default:
`list_issues` still defaults to `source: "github"`.

## Files to touch

- `electron/control-server.ts` — `ControlDeps.layoutPersistence`; new `context` branch.
  Import `findWorkspaceForPane`, `matchProjectByPath` from `./pane-context`.
- `electron/webview-server.ts` — constructor param + private field + deps literal.
- `electron/ipc/webview.ts` — `createWebviewServer` param, forwarded.
- `electron/app-lifecycle.ts` — pass `layoutPersistence` at the `createWebviewServer` call.

## Checks

- `pnpm exec tsc --noEmit -p tsconfig.electron.json` — ~31 pre-existing errors; add none.
  If the count or the set changed, quote the delta in your report.
- `pnpm exec vitest run electron/` — existing suites must still pass. The `WebviewServer`
  constructor is called with fewer args in existing tests; your new param must be optional
  so they keep compiling. Do **not** add tests — ticket 4 owns that.
- `pnpm exec eslint` on each file you touched.

## Commit

Stage only the four files above, by name.

  git commit -m "feat(adr-150): Add GET /context route and thread layoutPersistence"

No `Co-Authored-By` trailer — this repo forbids them.
