---
title: Shared pasted-image writer and constants
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Shared pasted-image writer and constants

Implements D1 of ADR-239.

- New `src/lib/pasted-image.ts`. It imports nothing, because both the browser and main read it, like `electron/bridge/routes.ts`. Export:
  - `MAX_PASTED_IMAGE_BYTES = 16 * 1024 * 1024`
  - `PASTED_IMAGE_CHUNK_BYTES = 512 * 1024`
  - `PASTED_IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as const`
  - `pastedImageExtension(mime: string): string | null`

  Give it a doc comment explaining two sizes:
  - The chunk size sits against `MAX_FRAME_BYTES` (`src/lib/relay-crypto/channel.ts:21`). A frame over 1 MiB closes the whole connection, and 512 KiB of raw bytes is about 700 KiB of base64.
  - The upload cap sits below the daemon's 20 MiB `writeFile` cap (`electron/terminal-host/index.ts:54`).
- New `electron/server/pasted-images.ts`. Move `timestamp()` and the directory, name, write and sweep body out of `electron/ipc/paste-image.ts` into `writePastedImage(registry: Pick<BackendRegistry, "get">, hostId: string, bytes: Buffer, ext: string): Promise<string>`.
  - It writes `~/.manor/pasted-images/<yyyymmdd-hhmmss>-<8 hex>.<ext>`.
  - Keep the comment explaining why it uses `registry.get` and not `RoutedBackend.shell`.
  - Keep the fire-and-forget `find <dir> -type f -mtime +7 -delete` sweep.
  - It throws when the write fails. Callers decide what result to return.
- `electron/ipc/paste-image.ts`: `uploadClipboardImage` keeps its signature and `PasteClipboardImageResult`. The try block becomes `return { kind: "uploaded", path: await writePastedImage(registry, hostId, clipboardImage.toPNG(), "png") }`.

## Tests
- `electron/ipc/__tests__/paste-image.test.ts` must pass unchanged.
- New `electron/server/__tests__/pasted-images.test.ts`, following `paste-image.test.ts`'s `makeRegistry` pattern. Cover:
  - the path's shape for each extension;
  - `writeFile` is called with the bytes;
  - the sweep's arguments;
  - a sweep failure is ignored;
  - a write failure is rethrown.
- New `src/lib/__tests__/pasted-image.test.ts` for `pastedImageExtension`.

## Files to touch
- `src/lib/pasted-image.ts` (new)
- `src/lib/__tests__/pasted-image.test.ts` (new)
- `electron/server/pasted-images.ts` (new)
- `electron/server/__tests__/pasted-images.test.ts` (new)
- `electron/ipc/paste-image.ts`
