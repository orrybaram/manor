---
title: Typed HttpError; delete the regex error-message parsing
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Typed `HttpError`; delete the regex error-message parsing

Behavior-preserving. Existing tests must pass untouched.

## The problem

We designed a structured 404 body (`{ error, candidates: [{projectId, name, path}] }`), then
threw the structure away by formatting it into a string, then reconstituted it with a regex.

`electron/mcp-webview-server.ts:60-63`:
```ts
if (!res.ok) {
  const body = await res.text();
  throw new Error(`HTTP ${res.status}: ${body}`);
}
```

`electron/mcp/context.ts:38-46`:
```ts
const match = /^HTTP 404: ([\s\S]*)$/.exec(err.message);
if (!match) return null;
body = JSON.parse(match[1]) as ContextNotFound;
```

Any change to that template string silently degrades the candidate listing into a wall of
JSON, and no test catches it.

## The fix

In `electron/mcp-webview-server.ts`, export a typed error:

```ts
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly rawBody: string,
  ) {
    super(`HTTP ${status}: ${rawBody}`);
    this.name = "HttpError";
  }
}
```

Keep `message` byte-identical to today's (`HTTP ${status}: ${rawBody}`) so any caller or test
matching on the message text keeps working. Parse the body opportunistically:

```ts
if (!res.ok) {
  const rawBody = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(rawBody); } catch { /* not JSON; body stays null */ }
  throw new HttpError(res.status, parsed, rawBody);
}
```

⚠ **Check the retry loop.** `request()` iterates `candidatePorts()` and catches per-port,
inspecting `err instanceof TypeError && err.cause` to decide whether it is a connection error
worth trying the next port. An `HttpError` is *not* a connection error — confirm it still
propagates out rather than causing a pointless retry against the next candidate port. Read the
surrounding code before you change it; do not alter the retry semantics.

⚠ **Import direction.** `electron/mcp/context.ts` currently imports nothing from
`mcp-webview-server.ts` (the server imports the tool modules, not the reverse). Putting
`HttpError` in `mcp-webview-server.ts` and importing it from `mcp/context.ts` creates a cycle.
**Put `HttpError` in `electron/mcp/types.ts`** — that is the shared-contract module for the MCP
process (`Http`, `ToolDef`, `ToolModule`, `text()`), it has no imports, and both sides already
depend on it. `mcp-webview-server.ts` imports and throws it; `mcp/context.ts` imports and
narrows on it.

## `mcp/context.ts`

Replace `candidateListing()` entirely:

```ts
export async function resolveContext(http: Http): Promise<CallerContext> {
  const params = new URLSearchParams();
  const paneId = process.env.MANOR_PANE_ID;
  if (paneId) params.set("paneId", paneId);
  params.set("cwd", process.cwd());

  try {
    return (await http.get(`/context?${params.toString()}`)) as CallerContext;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      const body = err.body as ContextNotFound | null;
      if (body?.error && Array.isArray(body.candidates)) {
        const listing = body.candidates
          .map((c) => `  - ${c.projectId}: ${c.name} (${c.path})`)
          .join("\n");
        throw new Error(listing ? `${body.error}\n${listing}` : body.error);
      }
    }
    throw err;
  }
}
```

No regex. No `JSON.parse`. No `[\s\S]*`. A non-404, or a 404 with an unexpected body shape,
rethrows the original error untouched — same as today.

The awkward `const friendly: Error & { cause?: unknown }` dance exists only because
`tsconfig.electron.json` targets ES2020, whose `Error` lacks `cause`. Keep that workaround if
the lint rule `preserve-caught-error` still demands a cause; otherwise drop it. Do not bump
the tsconfig lib in this ticket — that is a separate change with a 31-error blast radius.

## Files to touch

- `electron/mcp/types.ts` — add and export `HttpError`.
- `electron/mcp-webview-server.ts` — throw `HttpError` from `request()`; preserve message text
  and retry semantics.
- `electron/mcp/context.ts` — delete `candidateListing`; narrow on `HttpError` instead.

## Checks

- `pnpm exec vitest run electron/` — existing suite passes unmodified. Two known pre-existing
  failures in `electron/__tests__/tasks-unseen-source-of-truth.test.ts`; ignore only those.
- `pnpm exec tsc --noEmit -p tsconfig.electron.json` — exactly **31** pre-existing errors;
  introduce none, quote any delta.
- `pnpm exec eslint` on each file you touched.

## Commit

Stage your three files by name. Never `git add -A`.

  git commit -m "refactor(adr-151): Typed HttpError; delete regex error-message parsing"

No `Co-Authored-By` trailer.
