---
title: Create sourcemap symbolication module
status: done
priority: critical
assignee: opus
blocked_by: []
---

# Create sourcemap symbolication module

Create `electron/sourcemap-symbolication.ts` that exports a JS string (`SYMBOLICATION_SCRIPT`) containing self-contained source map symbolication functions designed to run inside a webview's JS context.

The exported string should define these functions on `window.__manor_symbolication__`:

### `symbolicateFrame(fileName, lineNumber, columnNumber)` → `Promise<{fileName, lineNumber, columnNumber} | null>`

1. Check cache (`window.__manor_sourcemap_cache__`) for previously fetched source maps
2. `fetch()` the bundle file at `fileName`
3. Extract `//# sourceMappingURL=...` from the last few lines
4. Fetch the source map:
   - If URL is a `data:application/json;base64,...` URI, decode inline
   - Otherwise resolve relative to bundle URL and `fetch()`
5. Parse the source map JSON, decode the `mappings` field using VLQ decoding
6. Binary search the decoded mappings for the segment matching `lineNumber`/`columnNumber`
7. Return `{ fileName: sources[sourceIndex], lineNumber: originalLine, columnNumber: originalColumn }`
8. Cache the parsed source map keyed by bundle URL

### `normalizeFileName(fileName)` → `string`

Strip prefixes: `webpack://`, `webpack-internal://`, `turbopack://`, `file:///`, `webpack:///./`, and app-name segments after `webpack:///`. Remove query strings and hash fragments.

### `isSourceFile(fileName)` → `boolean`

Return false for paths matching: `node_modules`, `.next`, `dist`, `build`, and patterns like `chunk-`, `vendor-`, `runtime-`, hex hashes, `.min.js`.

### VLQ Decoder

Inline a minimal VLQ decoder for source map `mappings` strings. This is ~40 lines:
- Decode base64 VLQ segments separated by `,` (same line) and `;` (new line)
- Each segment is [generatedColumn, sourceIndex, originalLine, originalColumn, nameIndex]
- Return a 2D array: `decodedMappings[generatedLine][segmentIndex]`

### Important constraints

- The entire module must be a **string literal** (like `PICKER_SCRIPT`) since it's injected via `executeJavaScript()`
- No npm dependencies — everything must be self-contained
- Use `var` declarations and ES5-compatible syntax (webview compat with the existing picker script style)
- Wrap in an IIFE that assigns to `window.__manor_symbolication__`
- All fetches should have reasonable timeouts (2s) and error handling that falls back gracefully (return null, don't throw)

## Files to touch
- `electron/sourcemap-symbolication.ts` — **new file**, the entire implementation
