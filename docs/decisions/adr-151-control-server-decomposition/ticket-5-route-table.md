---
title: Route table and electron/routes decomposition
status: done
priority: critical
assignee: opus
blocked_by: [1, 2, 3, 4]
---

# Route table and `electron/routes/` decomposition

The big one. **Strictly behavior-preserving.** Every existing test must pass with **zero edits**.
If a test needs changing, the refactor is wrong — stop and report.

Runs last, on green tests, after tickets 1–4 have already shrunk the routes.

## The problem

`handleControlRequest` (`control-server.ts:280-837`) is a single **558-line function** that
hand-rolls HTTP dispatch. Measured: **62 `json(…)` call sites, 13 hand-written
`Method not allowed` branches, 5 verbatim copies** of the renderer-proxy block.

Dispatch is done positionally, per route:
```ts
if (segments[0] === "panes") {
  if (segments.length === 3 && segments[2] === "focus") {
    if (method !== "POST") { json(405, …); return true; }
    const paneId = decodeURIComponent(segments[1]);
```
plus `const sub = segments[2]; const subsub = segments[3];` and a
`if (segments[0] !== "projects") return false;` fallthrough.

## The fix

### 1. A tiny matcher

```ts
interface RouteContext {
  deps: ControlDeps;
  params: Record<string, string>;   // decoded
  url: URL;
  json: Json;
  readBody: ReadBody;
}

interface Route {
  method: "GET" | "POST" | "DELETE";
  path: string;                      // "/projects/:projectId/issues/:issueRef"
  handler: (ctx: RouteContext) => Promise<void>;
}
```

Matching rules, and they matter:
- Split both the request path and the route pattern on `/`, dropping empties.
- Segment counts must be equal. A `:name` segment matches anything and captures it
  (`decodeURIComponent` once, centrally).
- **Path matched but method did not → one `405 { error: "Method not allowed" }`, once.**
  This is what deletes all 13 branches. Compute it by collecting every route whose *path*
  matches, then checking whether any of them matches the method.
- No route path matched at all → `return false`, so `webview-server.ts` can try `/webviews`
  and `/webview/:id/*`. **This is load-bearing** — `handleControlRequest` returning `false` is
  how the caller knows to fall through. Today only `segments[0] !== "projects"` reaches it.
- Unknown sub-path *under* a known prefix currently returns `404 { error: "Not found" }`
  (e.g. `/panes/x/y/z`, and the trailing `json(404)` at `:835`). Preserve that: if the first
  segment is one this module owns (`agents`, `context`, `panes`, `tabs`, `projects`) but no
  route matched, respond `404 { error: "Not found" }` and return `true`. Do **not** return
  `false` there — that would change behavior.

Order routes most-specific-first so `/panes/split` is not swallowed by `/panes/:paneId`. Note
`/panes/split` is POST and `/panes/:paneId` is DELETE, so they do not actually collide today —
but do not rely on that; make specificity explicit and add a comment.

### 2. `proxyToRenderer`

Five verbatim copies of this exist (`listPanes`, `splitPane`, `focusPane`, `closePane`, `newTab`):

```ts
const result = await requestRenderer<T>(cmd, args);
if (!result.ok) { json(rendererErrorStatus(result.error), { error: result.error }); return true; }
json(200, result.data);
```

Collapse to one helper. Keep `rendererErrorStatus`'s exact 503-vs-400 mapping.

### 3. Split into `electron/routes/`

- `electron/routes/agents.ts` — `POST /agents`
- `electron/routes/context.ts` — `GET /context` (plus `Resolution`, `resolveByPane`, `resolveByCwd` from ticket 3)
- `electron/routes/panes.ts` — `/panes`, `/tabs`
- `electron/routes/projects.ts` — `/projects`, `/projects/:id`, `/projects/:id/workspaces`, batch
- `electron/routes/issues.ts` — `/projects/:id/issues`, `/projects/:id/issues/:issueRef`

`control-server.ts` keeps: `ControlDeps`, `AppCommand` / `AppCommandResult` / `RendererResponse`,
`requestRenderer` + `installResultListener` + `pendingRequests`, `startAgent`, `runSetupScript`,
`notifyProjectsChanged`, `rendererErrorStatus`, `proxyToRenderer`, the route table, and the
matcher. Target: **under 200 lines**.

⚠ **Preserve every export.** `startAgent`, `runSetupScript`, `notifyProjectsChanged`,
`requestRenderer`, `AppCommand`, `handleControlRequest` are imported elsewhere
(`webview-server.ts`, `ipc/`, tests). Grep before you move anything. `handleControlRequest` keeps
its exact signature `(deps, method, url, json, readBody) => Promise<boolean>`.

⚠ **Shared per-route work.** Several `/projects/:id/*` routes today share a preamble: the
`projectManager` null-check (503), `getProjects()`, and the `project not found` 404. Do not
duplicate that five times. Either a small `withProject(handler)` wrapper, or a helper the
handlers call on line one. Prefer the wrapper — it keeps the 503/404 policy in one place. But
watch the ordering: `POST /projects` (create) must **not** run the project lookup, and
`GET /projects` (list) must not either.

⚠ **`notifyProjectsChanged()` call sites.** Four of them (`addProject`, batch, `createWorktree`,
`removeWorktree`). Keep each exactly where it is relative to its mutation and its `json(…)`.
Do not "helpfully" hoist it into the dispatcher — `/panes` and `/tabs` mutate layout, not
projects, and must not fire it.

## Files to touch

- `electron/control-server.ts` — reduce to dispatcher + shared renderer plumbing.
- `electron/routes/agents.ts`, `context.ts`, `panes.ts`, `projects.ts`, `issues.ts` — new.
- `electron/routes/router.ts` — new, if you prefer the matcher in its own file. Unit-test it if so.

Do **not** touch `webview-server.ts`, `issue-backends.ts`, `issue-sources.ts`, `pane-context.ts`,
`mcp/*`, or any test file.

## Checks — this ticket is judged on these

- `pnpm exec vitest run electron/` — **every test passes with zero edits to any test file.**
  The only permitted failures are the 2 known pre-existing ones in
  `electron/__tests__/tasks-unseen-source-of-truth.test.ts` (`taskManager.getTaskById is not a
  function`). Run `git status` at the end and prove no test file is modified.
- `pnpm exec tsc --noEmit -p tsconfig.electron.json` — exactly **31** pre-existing errors.
  Note: 3 of them are `control-server.ts(…) TS18048: 'd.detail' is possibly 'undefined'` in the
  batch route. They will **move** to `electron/routes/projects.ts`. That is expected — the count
  must stay 31 and no *new* error codes may appear. Quote the before/after error sets.
- `pnpm exec eslint electron/control-server.ts electron/routes/`
- `pnpm build`
- Report `wc -l` for `control-server.ts` and every new file.

## If it gets away from you

This is a large mechanical diff. If you find yourself wanting to change a test, a status code,
an error string, or a call ordering — **stop and report** rather than pressing on. A partial,
correct decomposition (say, `/panes` + `/tabs` extracted, the rest still inline) is a far better
outcome than a complete one that quietly changes behavior. Say clearly what you did and did not
move.

## Commit

Stage your files by name. Never `git add -A`.

  git commit -m "refactor(adr-151): Route table and electron/routes decomposition"

No `Co-Authored-By` trailer.
