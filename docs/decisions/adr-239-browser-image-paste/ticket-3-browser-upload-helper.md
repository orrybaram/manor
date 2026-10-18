---
title: Browser upload helper
status: done
priority: high
assignee: sonnet
blocked_by: [2]
---

# Browser upload helper

Implements the upload half of D3 in ADR-239.

New `src/lib/paste-image-upload.ts`:
- `export class PasteImageError extends Error`, whose message is shown to the user.
- `export async function uploadPastedImage(paneId: string, blob: Blob, opts?: { onProgress?: (sentBytes: number, totalBytes: number) => void }): Promise<string>`.

What it does:
1. Validate before calling anything:
   - `pastedImageExtension(blob.type)`, else throw `PasteImageError("Only PNG, JPEG, GIF and WebP images can be pasted")`;
   - `blob.size <= MAX_PASTED_IMAGE_BYTES`, else a message that names the 16 MiB limit and the image's size.
2. Call `window.electronAPI.pasteImage.begin(paneId, { mime: blob.type, size: blob.size })`.
3. For each `blob.slice(off, off + PASTED_IMAGE_CHUNK_BYTES)`:
   - base64-encode it via `FileReader.readAsDataURL`, stripping the `data:…;base64,` prefix. Don't use `btoa` on large strings.
   - `await api.chunk(paneId, uploadId, index, b64)`.
   - Report progress.
4. Call `commit` and return the `path` it gives back.

On any error after `begin`, run `await api.abort(paneId, uploadId).catch(() => {})`, then rethrow.

## Tests
New `src/lib/__tests__/paste-image-upload.test.ts`. Install a fake `window.electronAPI`, following `remote-image-paste.test.ts`. Cover:
- chunk boundaries for a blob of 1 chunk, exactly 2 chunks, and 2.5 chunks;
- the decoded chunks joined together equal the input;
- type and size refusals never call `begin`;
- a failing `chunk` calls `abort` and rethrows;
- the path from `commit` is returned;
- the sequence of progress callbacks.

## Files to touch
- `src/lib/paste-image-upload.ts` (new)
- `src/lib/__tests__/paste-image-upload.test.ts` (new)
