---
title: Typed RendererResponse; delete rendererErrorStatus and the duplicated route validation
status: todo
priority: high
assignee: sonnet
blocked_by: [3]
---

# Typed RendererResponse; delete rendererErrorStatus and the duplicated route validation

Structural deletions #8 and #10. Behavior-preserving.

## The problem

`electron/routes/renderer-bridge.ts:127-132`:

```ts
export function rendererErrorStatus(error: string | undefined): number {
  return error === "No Manor window is open" || error === "Renderer did not respond" ? 503 : 400;
}
```

This reconstructs a status by string-comparing prose that `requestRenderer`
produced 20 lines earlier — one commit after `5767b54` ("Typed HttpError; delete
regex error-message parsing") deleted exactly this pattern from the MCP side.
The status is *known at the point of failure*: line 102 knows "no window", line
110 knows "timeout", and an `ok:false` over IPC knows "the renderer handler
threw". Reword either literal and every handler throw silently becomes a 503.

It is `export`ed and re-exported through `control-server.ts:37` for **one**
same-file call site (`proxyToRenderer`, line 146).

## What to do

### 1. Make the response a discriminated union

```ts
export type RendererResponse<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "unavailable" | "handler"; error: string };
```

- `requestRenderer`'s no-window path (line 102) → `kind: "unavailable"`
- its timeout path (line 110) → `kind: "unavailable"`
- `installResultListener`, when the renderer replies `ok: false` → `kind: "handler"`

`error` is now non-optional on the failure arm, which kills the
`json(400, { error: undefined })` → `"{}"` body case.

### 2. Collapse `rendererErrorStatus` into `proxyToRenderer`

```ts
export async function proxyToRenderer(json: Json, cmd: string, args?: Record<string, unknown>) {
  const result = await requestRenderer(cmd, args);
  if (!result.ok) {
    json(result.kind === "unavailable" ? 503 : 400, { error: result.error });
    return;
  }
  json(200, result.data);
}
```

Delete `rendererErrorStatus` and its re-export from `control-server.ts`.

### 3. Drop the fake generic

`requestRenderer<T>`'s `T` is a lie: line 113 casts `resolve` to
`RendererResponse<unknown>["resolve"]` and `data` arrives unvalidated off the IPC
wire. Its only production caller (`proxyToRenderer`) infers `unknown` anyway.
Make it `requestRenderer(...): Promise<RendererResponse<unknown>>` and delete the
cast at line 113. Update `electron/__tests__/mcp-webview-server.test.ts:1315`,
the only site that parameterizes it.

### 4. Delete the duplicated route validation

`electron/routes/panes.ts`:
- lines 29-34 check `direction ∈ {horizontal, vertical}`
- lines 66-78 check `contentType ∈ {terminal, browser}` and `browser ⇒ url: string`

`src/lib/app-commands.ts` checks all three (lines 177, 217, 232) — and, after
ticket 3, also `position`, `background`, `workspacePath`, and the coherence rules
the route copy never knew about. A handler throw maps to 400 via the `kind`
above, so the status is unchanged.

Delete both blocks. `/panes/split` and `/tabs` become:

```ts
async handler({ json, readBody }) {
  await proxyToRenderer(json, "split-pane", await readBody());
}
```

The only behavior change: with no window open, a bad `direction` now returns 503
("No Manor window is open") instead of 400. That is more accurate — we cannot
know the argument is bad if there is nobody to ask.

Delete the three route-validation tests in
`electron/__tests__/mcp-webview-server.test.ts` (~lines 1206-1226); `app-commands.test.ts`
already covers the rules.

## Files to touch
- `electron/routes/renderer-bridge.ts` — union type, `kind` at three sites, fold `rendererErrorStatus` into `proxyToRenderer`, drop the generic + cast
- `electron/routes/panes.ts` — delete both validation blocks
- `electron/control-server.ts` — drop the `rendererErrorStatus` re-export
- `electron/__tests__/mcp-webview-server.test.ts` — drop the route-validation tests; fix the one `requestRenderer<T>` call

## Verify
`pnpm typecheck` clean. Grep for `rendererErrorStatus` returns nothing.
`POST /panes/split {"direction":"sideways"}` still returns 400 with a window open.
