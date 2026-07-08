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

# ADR-151: Decompose control-server; give issue sources a real seam

## Context

ADR-145 extracted `control-server.ts` out of `webview-server.ts` so the latter would stay
under 1000 lines. Three ADRs later — 148 (Linear issues), 149 (pane tools), 150 (caller
context) — we have rebuilt the same monolith one layer down:

- `electron/control-server.ts`: **333 → 837 lines**
- `handleControlRequest`: **a single 558-line function** (`:280-837`)
- inside it: 62 `json(…)` call sites, 13 hand-written `Method not allowed` branches,
  5 verbatim copies of the `requestRenderer` → `rendererErrorStatus` → `json` block

Every route re-implements dispatch by hand: `segments[0] === "panes"`,
`segments.length === 3 && segments[2] === "focus"`, positional `decodeURIComponent`,
`sub` / `subsub`. That is a route table struggling to be born.

Three further defects, all behavior-preserving to fix:

1. **Issue routes branch on source four ways, with two error policies.** `GET /projects/:id/issues`
   and `GET /projects/:id/issues/:ref` each carry an `if (source === "linear") … else github …`.
   The Linear branch wraps its calls in try/catch → 502. The GitHub branch does not, so a
   failing `github.getIssueDetail` (`:645`) throws past the route and becomes a 500 via
   `WebviewServer`'s top-level catch. Same route, two policies, chosen by branch.

   ADR-148 argued *"a fourth source would justify an `IssueProvider` interface; two does not."*
   That counted the wrong noun. It is 2 sources × 2 routes = 4 branches, plus a divergent
   error policy, plus a third copy of the Linear-readiness predicate. The seam pays today.

2. **`mcp/context.ts` recovers a structured 404 body by regex-matching an error message.**
   `request()` (`mcp-webview-server.ts:60-63`) formats `HTTP ${status}: ${body}` into an
   `Error`; `candidateListing()` (`mcp/context.ts:38-46`) parses it back out with
   `/^HTTP 404: ([\s\S]*)$/` and a `JSON.parse`. Any change to that template silently
   degrades the candidate listing, and no test catches it.

3. **`/context` encodes one fact in two mutable variables.** `match` and `resolvedBy` are
   always set together, yet the code guards `if (!match || !resolvedBy)` — a branch the
   program cannot reach. And `resolvedBy` is serialized over HTTP and declared on
   `CallerContext` while ADR-150's own ticket says "do not print it; it is diagnostic".
   Nothing reads it but tests inspecting implementation through the public contract.

Also: the batch route's `source=linear` rejection (`:659-667`) reads `?source=` off the
query string of a POST whose every other parameter is in the body. `batch_create_workspaces`
never sends it. The guard is reachable only by a hand-crafted URL — which is exactly what
its test does.

## Decision

Five behavior-preserving changes, ordered so each lands on green tests. Existing tests are
the proof: they should pass untouched except where a contract is *deliberately* narrowed
(ticket 3).

### 1. `electron/issue-backends.ts` — the seam

Main-side and dep-aware, so `issue-sources.ts` stays pure as chartered.

```ts
interface IssueBackend {
  list(filter: "all" | "assigned", state: IssueState, limit: number): Promise<McpIssue[]>;
  detail(ref: string): Promise<McpIssueDetail>;
}

export function issueBackend(deps, project, source):
  | { ok: true; backend: IssueBackend }
  | { ok: false; status: number; error: string };

export function availableSources(deps, project): IssueSource[];
```

Each route collapses to one shape with **zero** source branching:

```ts
const chosen = issueBackend(deps, project, parsed.source);
if (!chosen.ok) { json(chosen.status, { error: chosen.error }); return true; }
try   { json(200, await chosen.backend.list(filter, state, limit)); }
catch (err) { json(502, { error: String(err) }); }
```

The GitHub backend owns its own numeric-ref validation (today squatting mid-route at `:640`)
and its own normalizer. Error policy is uniform because there is one call site — the
500-vs-502 split stops being expressible.

`availableSources` replaces the inline predicate at `:373-378`, which today duplicates
`resolveLinear`'s "connected && has associations" rule in a different shape. One rule, one
encoding; `resolveLinear` derives its 503-vs-400 from *why* it failed.

### 2. `HttpError` in the MCP process

```ts
class HttpError extends Error {
  constructor(readonly status: number, readonly body: unknown) { super(`HTTP ${status}`); }
}
```

`request()` throws it; `resolveContext` does `err instanceof HttpError && err.status === 404`
and reads `err.body.candidates` directly. Delete `candidateListing`'s regex and `JSON.parse`.

### 3. `Resolution` in `/context`

```ts
type Resolution = { project: ProjectInfo; workspace: WorkspaceInfo; resolvedBy: "paneId" | "cwd" };
const resolved = resolveByPane(deps, projects, paneId) ?? resolveByCwd(projects, cwd);
if (!resolved) { json(404, { error, candidates }); return true; }
```

Two `let`s and three assignment sites become one `const`. The impossible state stops being
representable, and each rung becomes a small named function.

**`resolvedBy` is dropped from the HTTP response and from `CallerContext`.** It is a
deliberate contract narrowing: nothing consumed it. Ticket 3 updates the tests to assert the
rungs through observable behavior instead — which workspace matched, and whether
`layoutPersistence.load` was called.

### 4. The batch guard

Read `source` from the **body**, consistent with every other parameter on that route. The
guard becomes reachable from the only real client, and its test stops fabricating its own
reachability.

### 5. Route table + `electron/routes/`

A ~30-line matcher over a declarative table:

```ts
const ROUTES: Route[] = [
  { method: "POST",   path: "/agents",                              handler: postAgent },
  { method: "GET",    path: "/context",                             handler: getContext },
  { method: "GET",    path: "/panes",                               handler: listPanes },
  { method: "POST",   path: "/panes/split",                         handler: splitPane },
  { method: "POST",   path: "/panes/:paneId/focus",                 handler: focusPane },
  { method: "DELETE", path: "/panes/:paneId",                       handler: closePane },
  { method: "POST",   path: "/tabs",                                handler: newTab },
  { method: "GET",    path: "/projects",                            handler: listProjects },
  … etc
];
```

Path matched but method did not → one `405`, once. This categorically deletes all 13 `405`
branches, every `segments.length === N` check, every positional `decodeURIComponent`, the
`if (segments[0] !== "projects") return false` fallthrough, and the `sub` / `subsub` naming.
Params arrive named and typed.

Handlers move into `electron/routes/{agents,context,panes,projects,issues}.ts`. The five
copies of the renderer-proxy block become one `proxyToRenderer(json, cmd, args)`.

## Consequences

**Better**

- `control-server.ts` returns to a dispatcher (~150 lines); no handler file approaches 1k.
- One error policy per route, enforced structurally rather than by discipline.
- Adding a route becomes a table row plus a function, not an if-branch in a 558-line body.
- Adding a third issue source is a new `IssueBackend`, touching no route.

**Worse / riskier**

- Ticket 5 is a large mechanical diff across every route. It lands last, on green tests, and
  is behavior-preserving by construction: if a test changes, the refactor is wrong.
- A route table is indirection. It earns its keep at 10 routes; at 3 it would not have.
- Dropping `resolvedBy` narrows a public response shape. Nothing consumes it, and it shipped
  hours ago, so the blast radius is zero — but it is a breaking change on paper.
- `ControlDeps` still carries four managers. Ticket 5 makes a container object cheap to
  introduce later; this ADR does not do it.

**Behavior changes we accepted** (none covered by a test, each a direct consequence of a rule
this ADR made load-bearing)

- `github` list/detail call throws → **502** instead of an unhandled throw surfacing as 500
  (ticket 1). This was the point: one error policy per route.
- Centralising the `405` moves the method check *ahead of* the `projectManager` 503 and the
  `project not found` 404, which used to run first (ticket 5):
  - `PUT /projects` with `projectManager === null`: was `503`, now `405`
  - `PATCH /projects/unknown-id/workspaces`: was `404 Project not found`, now `405`
  - `POST /agents/foo`, `GET /context/foo`, `/projects/:id/bogus`: now `404 Not found` via the
    owned-prefix rule
  Answering "wrong method" before "wrong state" is the more defensible order. Preserving the old
  order would require per-route method lists, which is precisely the 13 branches we deleted.
- `resolvedBy` removed from the `GET /context` response and from `CallerContext` (ticket 3).
  Nothing consumed it. Shipped hours earlier, so the blast radius is zero.

**Discovered, not fixed**

`GitHubManager.getMyIssues` / `getAllIssues` swallow errors and `return []` (`github.ts:190`,
`:216`). So ticket 1's `list → 502` is unreachable for GitHub: a failing `gh` still surfaces as
an empty list. `getIssueDetail` does throw, so `detail → 502` is live. **This is the root cause
of the silent-empty-backlog bug ADR-148 introduced** — the asymmetry we fixed at the route layer
still exists one layer down, inside the manager. Fixing it changes what the UI's issue list does
on a `gh` failure, so it needs its own ADR.

**Not done**

- `renderPrompt`'s GitHub-only `{number}` template and the `issues: number[]` batch schema
  stay. Fanning a Linear backlog into worktrees needs a branch-naming decision (ADR-148).
- The pre-existing `TS18048 'd.detail' is possibly undefined` narrowing gap in the batch
  route stays; a discriminated union would fix it, out of scope here.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
