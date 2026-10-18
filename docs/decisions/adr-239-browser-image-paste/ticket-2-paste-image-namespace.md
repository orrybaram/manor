---
title: pasteImage namespace with staging, routes and host table
status: done
priority: critical
assignee: opus
blocked_by: [1]
---

# pasteImage namespace: begin/chunk/commit/abort

Implements D2 of ADR-239. Read the ADR's Context first.

## The handler
New `electron/bridge/handlers/paste-image.ts`, with a header comment in the style of `pty.ts` and `chat.ts`.

**Types.** Export:
- `PasteImageDeps = { backendRegistry: Pick<BackendRegistry, "get">; getPaneHostId: PaneHostLookup }`. Check `SharedDeps` in `electron/ipc/types.ts` for the exact lookup type.
- `PasteImageBegin = { uploadId: string }`
- `PasteImageCommit = { path: string }`

**Handlers:** `pasteImageBegin`, `pasteImageChunk`, `pasteImageCommit` and `pasteImageAbort`, each `(ctx: HandlerCtx<D>, ...args)`.
- `begin(paneId, { mime, size })`:
  - `assertString(paneId)`. The mime must be in `PASTED_IMAGE_TYPES`, and `0 < size <= MAX_PASTED_IMAGE_BYTES`.
  - Resolve `hostId = ctx.deps.getPaneHostId(paneId) ?? LOCAL_HOST_ID`.
  - Refuse with "Too many uploads in progress" when the caller already has `MAX_UPLOADS_PER_CALLER = 4` uploads, or when total staged bytes plus `size` would exceed `MAX_STAGED_BYTES = 128 MiB`.
  - Create `{ id: crypto.randomBytes(16).toString("hex"), callerId: ctx.caller.id, paneId, hostId, ext, size, parts: Buffer[], received: 0, touched: Date.now() }`.
- `chunk(paneId, uploadId, index, base64)`:
  - The upload must exist, `callerId` must match `ctx.caller.id`, and `paneId` must match. Otherwise throw "Unknown upload".
  - Chunks arrive in order: `index === parts.length`. On any mismatch, drop the upload, then throw.
  - The base64 string must be at most `4 * Math.ceil(CHUNK / 3) + 4` long, checked **before** decoding. The decoded length must be at most `CHUNK`, and `received + decoded <= size`.
  - Append the chunk and update `touched`.
- `commit(paneId, uploadId)`:
  - Ownership as in `chunk`, and `received === size`.
  - `writePastedImage(ctx.deps.backendRegistry, upload.hostId, Buffer.concat(parts), upload.ext)`, from ticket 1's `electron/server/pasted-images.ts`.
  - Delete the staging in a `finally`. Return `{ path }`.
- `abort(paneId, uploadId)`: deletes the upload if the caller owns it. Never throws.

**Staging.** Keep staging in a module-level `Map`, like the module state in `pty-attachments.ts` and `chat.ts`.
- A sweep every 15 s via `setInterval(...).unref()` drops uploads idle for over `UPLOAD_IDLE_MS = 60_000`.
- Start the sweep lazily on the first `begin`, and clear it when the map empties.
- Export `_resetPasteImageUploadsForTests()`.

**Errors.** Throw plain `Error`s with user-readable messages; they become the toast's detail. Use `assertString` from `electron/ipc-validate.ts`. Add `assertNonNegativeInt` there if nothing existing fits the index.

**Imports.** Import the constants from `../../../src/lib/pasted-image`; `pty.ts` imports `src/lib/home-path` the same way. Import nothing from `electron`, because `electron/platform/__tests__/electron-free.test.ts` must still pass.

**Table.**
```ts
export const pasteImage = {
  begin: method(pasteImageBegin, { route: byPane(0) }),
  chunk: method(pasteImageChunk, { route: byPane(0) }),
  commit: method(pasteImageCommit, { mutating: true, route: byPane(0) }),
  abort: method(pasteImageAbort, { route: byPane(0) }),
};
```
Only `commit` is audited, with the pane as target. Chunks would add 32 audit lines per paste, and bodies are never recorded anyway.

## Wiring
- `electron/bridge/server-methods.ts`: add `pasteImage` to `SERVER_METHODS`.
- `electron/bridge/routes.ts`: add `"pasteImage.begin"`, `"pasteImage.chunk"`, `"pasteImage.commit"` and `"pasteImage.abort"`, all `byPane(0)`, with a comment saying the pane's own server stages the upload and writes the file.
- `electron/host-server/handlers.ts` `HOST_TABLE`: add
  ```ts
  pasteImage: {
    begin: method(pasteImageBegin),
    chunk: method(pasteImageChunk),
    commit: method(pasteImageCommit, { mutating: true }),
    abort: method(pasteImageAbort),
  }
  ```
  Add a comment: a device pastes into this host's panes, and the file lands on this box.
- `electron/bridge/__tests__/routes-surface.test.ts`: add `"pasteImage"` to `ROUTED_NAMESPACES`.
- `electron/bridge/__tests__/caller-class.test.ts`: in the MUTATING describe, assert `pasteImage.commit` is in the set and `pasteImage.chunk` is not, with a comment explaining why chunks aren't audited.

No change to `electron.d.ts` or the preload: the type is derived from the table.

## Tests
New `electron/bridge/handlers/__tests__/paste-image.test.ts`. Use `localCtx`, following `chat.test.ts`, with a fake `{ backendRegistry: { get }, getPaneHostId }`. Cover:
- **Happy path:** three chunks write the joined bytes to the pane's host, with the right extension.
- **Fallback:** when `getPaneHostId` returns undefined, the file goes to `LOCAL_HOST_ID`.
- **Refusals:**
  - a bad mime type
  - a size over the cap
  - a chunk out of order (the upload is then dropped)
  - a chunk past the declared size
  - an oversized base64 string
  - a commit with bytes missing
  - an unknown upload id
  - another caller's upload id
- **Lifecycle:**
  - abort drops the staging
  - the per-caller limit
  - the total limit
  - the idle sweep, with fake timers
  - a failed write clears the staging and rethrows

## Files to touch
- `electron/bridge/handlers/paste-image.ts` (new)
- `electron/bridge/handlers/__tests__/paste-image.test.ts` (new)
- `electron/bridge/server-methods.ts`
- `electron/bridge/routes.ts`
- `electron/host-server/handlers.ts`
- `electron/bridge/__tests__/routes-surface.test.ts`
- `electron/bridge/__tests__/caller-class.test.ts`
- `electron/ipc-validate.ts` (only if a non-negative-int assert is needed)
