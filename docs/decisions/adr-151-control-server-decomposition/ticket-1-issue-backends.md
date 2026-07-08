---
title: Extract issue-backends seam; collapse the two issue routes
status: todo
priority: critical
assignee: opus
blocked_by: []
---

# Extract `issue-backends.ts`; collapse the two issue routes

Behavior-preserving. **Existing tests in `electron/__tests__/mcp-webview-server.test.ts` must
pass untouched** — that is the proof this refactor is correct. If you find yourself editing a
test assertion, stop and reconsider; the only exception is noted at the bottom.

## The problem

`control-server.ts:553-648` — two routes, each branching on source:

```ts
if (parsed.source === "linear") {
  const target = resolveLinear(deps.linearManager, project);
  if (!target.ok) { json(target.status, { error: target.error }); return true; }
  try { … normalizeLinearIssue … } catch (err) { json(502, { error: String(err) }); }
  return true;
}
const github = deps.githubManager;
if (!github) { json(503, …); return true; }
const issues = await github.getAllIssues(…);   // ← NOT wrapped; a throw becomes a 500
json(200, issues.map(normalizeGitHubIssue));
```

Two error policies in one route, selected by branch. Four such branches across two routes.

## New file: `electron/issue-backends.ts`

Main-side, dep-aware. Keeps `electron/issue-sources.ts` pure (it must stay Electron-free and
import-free of managers — do not touch it beyond importing its types/normalizers).

```ts
import type { IssueSource, IssueState, McpIssue, McpIssueDetail } from "./issue-sources";

export interface IssueBackend {
  list(filter: "all" | "assigned", state: IssueState, limit: number): Promise<McpIssue[]>;
  detail(ref: string): Promise<McpIssueDetail>;
}

export function issueBackend(
  deps: Pick<ControlDeps, "githubManager" | "linearManager">,
  project: ProjectInfo,
  source: IssueSource,
): { ok: true; backend: IssueBackend } | { ok: false; status: number; error: string };

export function availableSources(
  deps: Pick<ControlDeps, "githubManager" | "linearManager">,
  project: ProjectInfo,
): IssueSource[];
```

Import `ControlDeps` as a type from `./control-server` — or, if that creates a cycle, define a
minimal local `IssueDeps { githubManager; linearManager }` interface and have `ControlDeps`
satisfy it structurally. Prefer whichever avoids the cycle; say which you chose.

### `issueBackend("github")`

- `!deps.githubManager` → `{ ok: false, status: 503, error: "GitHub is not available" }`.
  **Copy the exact string from the current code** — the batch route uses a *different* 503
  string; do not unify them, that route is out of scope.
- `list` → `filter === "all" ? getAllIssues(project.path, limit, state) : getMyIssues(project.path, limit, state)`, mapped through `normalizeGitHubIssue`.
- `detail(ref)` → owns the numeric validation currently squatting at `control-server.ts:640-644`:
  `Number.parseInt(ref, 10)`; if not finite or `<= 0`, **throw** `new Error("GitHub issue refs must be numeric.")`.
  Then `getIssueDetail(project.path, n)` → `normalizeGitHubIssueDetail`.

  ⚠ Careful: today that validation produces a **400**, not a 502. See "Error mapping" below.

### `issueBackend("linear")`

Reuse the existing `resolveLinear` logic — move it into this module (it is the only caller
site). Preserve both messages and both statuses exactly:
- not connected → `{ ok: false, status: 503, error: "Linear is not connected. Connect Linear in Manor settings." }`
- no associations → `{ ok: false, status: 400, error: "Project has no Linear team associated." }`

- `list` → `filter === "all" ? getAllIssues(teamIds, opts) : getMyIssues(teamIds, opts)` with
  `opts = { stateTypes: linearStateTypes(state), limit }`, mapped through `normalizeLinearIssue`.
- `detail(ref)` → `getIssueDetail(ref)` verbatim (Linear resolves both UUID and `ENG-123`),
  through `normalizeLinearIssueDetail`.

### `availableSources`

Replaces the inline predicate at `control-server.ts:373-378`, which today duplicates
`resolveLinear`'s rule in a different shape.

- push `"github"` when `deps.githubManager` is non-null.
- push `"linear"` when `deps.linearManager?.isConnected()` **and** the project has at least one
  Linear association.

Express both `availableSources` and `issueBackend("linear")`'s guards in terms of **one**
private predicate so they cannot drift. `resolveLinear`'s two distinct errors derive from
*which* condition failed.

Note: `project.linearAssociations` is declared **non-optional** (`persistence.ts:70`). The
current code hedges with `?? []` against its own type. Trust the type; drop the `??`.

## Error mapping — read carefully

Today's statuses, which must be preserved:

| Situation | Today | Keep |
| --- | --- | --- |
| github manager absent | 503 | 503 |
| linear not connected | 503 | 503 |
| linear, no team associated | 400 | 400 |
| linear call throws (bad token) | 502 | 502 |
| github non-numeric ref | 400 | 400 |
| github call throws | **500** (unhandled) | **502** ← the fix |

So the route cannot blanket-map every `catch` to 502: a non-numeric GitHub ref must stay 400.
Cleanest: give the backend's `detail` a typed rejection for caller error, e.g.

```ts
export class InvalidIssueRef extends Error {}
```

and in the route: `catch (err) { json(err instanceof InvalidIssueRef ? 400 : 502, { error: String(err) }); }`

Alternative if you prefer: validate the ref in `issueBackend()` construction rather than in
`detail()`. Either is fine — pick one, and make sure the 400 message text is unchanged.

The `github call throws → 500 becomes 502` change is the one **intentional** behavior change in
this ticket. It fixes the asymmetry. No existing test asserts the 500.

## Rewrite the two routes

`control-server.ts:553-648`. Each becomes, modulo the detail/list call:

```ts
const parsed = parseSource(url);
if (!parsed.ok) { json(400, { error: parsed.error }); return true; }
const chosen = issueBackend(deps, project, parsed.source);
if (!chosen.ok) { json(chosen.status, { error: chosen.error }); return true; }
try {
  json(200, await chosen.backend.list(filter, state, limit));
} catch (err) {
  json(502, { error: String(err) });
}
return true;
```

Zero `source === "linear"` branches remain in `control-server.ts`. Delete `resolveLinear` from
it (moved), and drop the now-unused normalizer / `linearStateTypes` imports.

Then rewrite the `sources` computation at `:371-378` to `availableSources(deps, match.project)`.

Do **not** touch: the batch route, `/panes`, `/tabs`, `/context`'s resolution ladder,
`parseSource`, or `issue-sources.ts`.

## Files to touch

- `electron/issue-backends.ts` — new.
- `electron/issue-backends.test.ts` — new. Colocated unit tests (convention: `issue-sources.test.ts`).
  Cover: both backends' `list` for `filter=all` vs `assigned` (assert the args handed to each
  manager stub), `detail` numeric validation, both `issueBackend` failure shapes with exact
  strings/statuses, `availableSources` × the five combinations (github+linear, linear connected
  but no associations → `["github"]`, `isConnected()` false → `["github"]`, no github → `["linear"]`,
  neither → `[]`). Use plain `vi.fn()` stubs for the managers; **no `vi.mock("electron")`** should
  be needed.
- `electron/control-server.ts` — collapse both issue routes; delete `resolveLinear`; use
  `availableSources`.

## Checks

- `pnpm exec vitest run electron/` — the existing suite must pass **unmodified**. Known
  pre-existing failures: 2 in `electron/__tests__/tasks-unseen-source-of-truth.test.ts`
  (`taskManager.getTaskById is not a function`). Ignore those two only.
  **Exception:** if a test asserts a 500 for a throwing GitHub call, update it to 502 and say so
  loudly in your report. I do not believe one exists.
- `pnpm exec tsc --noEmit -p tsconfig.electron.json` — exactly **31** pre-existing errors.
  Introduce none; quote any delta.
- `pnpm exec eslint` on each file you touched.
- Report `wc -l electron/control-server.ts` before and after.

## Commit

Stage your three files by name. Never `git add -A`.

  git commit -m "refactor(adr-151): Extract issue-backends seam; collapse the two issue routes"

No `Co-Authored-By` trailer — this repo forbids them.
