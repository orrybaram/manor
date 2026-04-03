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

# ADR-064: Source Map Symbolication for React Component Stacks

## Context

Manor's element picker and webview server extract React component stacks by walking the fiber tree and parsing `_debugStack` stack traces. Currently, the parsed file paths are **bundled file URLs** (e.g., `/_next/static/chunks/node_modules__pnpm_7e158bcb._.js:1063`) rather than original source file paths.

The react-grab project (github.com/aidenybai/react-grab) solves this via client-side source map symbolication — fetching bundle files, extracting their `sourceMappingURL`, fetching the `.map` file, and decoding VLQ mappings to resolve original file/line/column.

The two places that extract fiber info are:
- `electron/picker-script.ts` — injected into the webview as an IIFE string
- `electron/webview-server.ts` — duplicated inline in the `element-context` endpoint's `executeJavaScript` call

Both run inside the webview's JS context and have access to `fetch()`.

## Decision

Add client-side source map symbolication to the picker script and webview server's element-context script. Since both scripts run inside the webview (via `executeJavaScript`), they can `fetch()` bundle files and source maps directly from the dev server.

### Approach

1. **Create `electron/sourcemap-symbolication.ts`** — a module that exports a self-contained JS string (like `PICKER_SCRIPT`) containing the symbolication functions. Both picker-script.ts and webview-server.ts will import and embed this string.

2. **Symbolication flow** (runs inside the webview):
   - After extracting a stack frame with a bundle URL + line + column:
     1. `fetch()` the bundle file content
     2. Find the `//# sourceMappingURL=...` comment
     3. `fetch()` the source map (supports external URLs and inline base64 data URIs)
     4. Decode VLQ mappings using a lightweight inline decoder (no npm dependency needed — VLQ decoding is ~40 lines)
     5. Binary search the decoded mappings for the original source, line, and column
   - Cache source maps per bundle URL to avoid redundant fetches
   - Normalize resulting paths: strip `webpack://`, `turbopack://`, `file:///` prefixes

3. **Make `getReactFiberInfo` async** — symbolication requires `fetch()`, so the function becomes async. Update callers:
   - In picker-script.ts: the `onClick` handler awaits fiber info before posting result
   - In webview-server.ts: the `executeJavaScript` call already returns a promise

4. **Path normalization and filtering**:
   - Strip bundler scheme prefixes (`webpack://`, `turbopack://`, `webpack-internal://`, `file:///`)
   - Remove query strings and hash fragments
   - Filter out non-source frames: paths containing `node_modules`, `.next`, `dist`, or matching patterns like `chunk`, `vendor`, `runtime`

5. **No new npm dependencies** — VLQ decoding is simple enough to inline (~40 lines). The `sourceMappingURL` extraction is a regex. This keeps the injected script self-contained.

### Key Files

| File | Change |
|------|--------|
| `electron/sourcemap-symbolication.ts` | **New** — shared JS string with symbolication functions |
| `electron/picker-script.ts` | Import symbolication string, make `getReactFiberInfo` async, embed symbolication in IIFE |
| `electron/webview-server.ts` | Import symbolication string, embed in `element-context` script, await result |

## Consequences

**Better:**
- Component stacks show original source file paths with correct line numbers
- Claude/MCP tools can navigate directly to source files
- Parity with react-grab's output quality

**Tradeoffs:**
- Symbolication adds latency (~50-200ms per unique bundle file, cached after first fetch) to element picking
- Only works in dev mode where source maps are served (fine — this is a dev tool)
- The injected script grows by ~80-100 lines for the VLQ decoder and symbolication logic

**Risks:**
- Some bundlers may not serve source maps by default (Vite does in dev mode)
- Inline base64 source maps can be large; fetching the bundle content to find the URL is an extra network request

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
