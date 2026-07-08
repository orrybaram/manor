---
title: Resolution type in /context; drop resolvedBy from the wire
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# `Resolution` type in `/context`; drop `resolvedBy` from the wire

## The problem

`control-server.ts:323-355`:

```ts
let match: { project: ProjectInfo; workspace: WorkspaceInfo } | null = null;
let resolvedBy: "paneId" | "cwd" | null = null;
…
if (!match || !resolvedBy) { json(404, …); return true; }
```

`match` set ⇒ `resolvedBy` set, always. The `|| !resolvedBy` guards a state the program cannot
reach. Two mutable `let`s and three assignment sites encode one value.

Separately, `resolvedBy` is serialized over HTTP and declared on `CallerContext`, yet ADR-150's
own ticket says "do not print `resolvedBy`; it is diagnostic". Nothing consumes it. Its only
readers are tests reaching through the public contract to inspect an implementation detail.

## The fix

Two small named rung functions and one `const`:

```ts
interface Resolution {
  project: ProjectInfo;
  workspace: WorkspaceInfo;
  resolvedBy: "paneId" | "cwd";
}

function resolveByPane(
  layoutPersistence: LayoutPersistence | null,
  projects: ProjectInfo[],
  paneId: string | null,
): Resolution | null;

function resolveByCwd(projects: ProjectInfo[], cwd: string | null): Resolution | null;
```

Route body:

```ts
const resolved =
  resolveByPane(deps.layoutPersistence, projects, paneId) ??
  resolveByCwd(projects, cwd);
if (!resolved) {
  json(404, { error: "…", candidates: projects.map(…) });
  return true;
}
```

`resolveByPane` keeps every semantic the current code has, and the comments explaining them —
they are load-bearing:
- `paneId` null → return null immediately.
- `layoutPersistence?.load()` wrapped in try/catch; a throw returns null (corrupt/torn file).
- layout null, pane absent from layout, or workspacePath matching no project → null.
- **Never 404 from inside a rung.** Falling through to `cwd` is the debounce-lag case.

`resolveByCwd` returns null when `cwd` is null or matches nothing.

Keep `resolvedBy` **inside** `Resolution` — it costs nothing and names which rung fired.
Just do not put it in the response.

## Drop `resolvedBy` from the wire

This is a deliberate, intentional contract narrowing. It is the one place in ADR-151 where
tests must change.

- `control-server.ts` — remove `resolvedBy` from the `json(200, {...})` body.
- `electron/mcp/context.ts` — remove `resolvedBy` from `CallerContext`. Nothing reads it;
  `current_workspace`'s handler already deliberately does not print it.
- `electron/__tests__/mcp-webview-server.test.ts` — the `GET /context` block asserts
  `resolvedBy` to tell the rungs apart. Rewrite those assertions to use **observable** behavior:
  - which workspace matched (`workspacePath`) — the fixtures already point the two rungs at
    different workspaces, which is why these tests can distinguish them at all;
  - whether `layoutPersistence.load` was called (`expect(load).toHaveBeenCalled()` /
    `.not.toHaveBeenCalled()`).

  Every case in that block must survive: paneId rung, cwd rung (worktree beats main via
  longest-prefix), paneId-wins-over-cwd, paneId-miss-falls-through-to-cwd, corrupt layout falls
  through, no-layoutPersistence falls through, 404 with non-empty candidates, 405, 503.
  **Do not delete a case** because it is now awkward to assert. If a case genuinely cannot be
  distinguished without `resolvedBy`, say so in your report rather than dropping it — that
  would be evidence the field should stay.

Do not touch the `sources` computation (ticket 1 already rewrote it to `availableSources`), the
ladder's ordering, or any other route.

## Files to touch

- `electron/control-server.ts` — `Resolution`, `resolveByPane`, `resolveByCwd`; `resolvedBy`
  out of the response.
- `electron/mcp/context.ts` — `resolvedBy` off `CallerContext`.
- `electron/__tests__/mcp-webview-server.test.ts` — re-express the rung assertions.

## Checks

- `pnpm exec vitest run electron/` — all pass except the 2 known pre-existing failures in
  `electron/__tests__/tasks-unseen-source-of-truth.test.ts`. Report exact counts.
- `pnpm exec tsc --noEmit -p tsconfig.electron.json` — exactly **31** pre-existing errors;
  introduce none, quote any delta.
- `pnpm exec eslint` on each file you touched.

## Commit

Stage your three files by name. Never `git add -A`.

  git commit -m "refactor(adr-151): Resolution type in /context; drop resolvedBy from the wire"

No `Co-Authored-By` trailer.
