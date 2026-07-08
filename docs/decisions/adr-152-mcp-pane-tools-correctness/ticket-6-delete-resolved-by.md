---
title: Delete resolvedBy, Resolution, and resolveByCwd
status: todo
priority: medium
assignee: haiku
blocked_by: [5]
---

# Delete resolvedBy, Resolution, and resolveByCwd

Structural deletion #13. Behavior-preserving. Small and mechanical.

## The problem

ADR-151 §3 dropped `resolvedBy` from the HTTP response — and the response at
`electron/routes/context.ts:98-106` does omit it. But the field survives on the
internal `Resolution` type (line 21) and is assigned at lines 47 and 61. Nothing
reads it. Ticket 3 of ADR-151 said "keep `resolvedBy` inside `Resolution` — it
costs nothing."

It costs this:

```ts
function resolveByCwd(projects, cwd): Resolution | null {
  if (!cwd) return null;
  const match = matchProjectByPath(projects, cwd);
  if (!match) return null;
  return { ...match, resolvedBy: "cwd" };   // ← the entire purpose of the function
}
```

Strip the dead field and `resolveByCwd` **is** `matchProjectByPath` — a 9-line
identity wrapper. And `Resolution` becomes
`ReturnType<typeof matchProjectByPath>`, i.e. it stops needing to exist.

## What to do

1. Delete the `Resolution` interface (lines 17-22).
2. Delete `resolveByCwd` (lines 54-62).
3. `resolveByPane` returns `{ project, workspace } | null` — i.e.
   `ReturnType<typeof matchProjectByPath>`. Drop its `resolvedBy` spread; it can
   `return match` directly. Keep the function: it does real work (load +
   `findWorkspaceForPane` + match).
4. In the handler:

```ts
const resolved =
  resolveByPane(deps.layoutPersistence, projects, paneId) ??
  (cwd ? matchProjectByPath(projects, cwd) : null);
```

5. While here, delete the dead `try/catch` at lines 38-42. Its comment says
   *"A corrupt or half-written file is the same fall-through, not a 500"* — but
   `LayoutPersistence.load()` (`electron/terminal-host/layout-persistence.ts:144-159`)
   already wraps its entire body in `try { ... } catch { return null }`. It cannot
   throw. Replace with `const layout = layoutPersistence?.load() ?? null;`

6. Delete the test at `electron/__tests__/mcp-webview-server.test.ts:1643`
   (*"falls through to cwd when the layout is corrupt (load throws)"*) — it mocks
   `load: vi.fn(() => { throw ... })`, a behavior the production class cannot
   exhibit. The adjacent test at ~line 1658 (`load` returns `null`) is the real one
   and must stay green.

## Files to touch
- `electron/routes/context.ts` — delete `Resolution`, `resolveByCwd`, the `resolvedBy` spreads, the dead `try/catch`
- `electron/__tests__/mcp-webview-server.test.ts` — delete the phantom "load throws" test

## Verify
`pnpm typecheck` clean. Grep for `resolvedBy` returns nothing. The `/context`
resolution-ladder tests still pass unchanged — the HTTP response shape does not move.
