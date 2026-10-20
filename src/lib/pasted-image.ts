/**
 * Shared constants for pasting an image into a remote pane from the browser.
 * Imports nothing: both the browser and main read it.
 *
 * Two sizes live here:
 * - `PASTED_IMAGE_CHUNK_BYTES` sits against `MAX_FRAME_BYTES`
 *   (`src/lib/relay-crypto/channel.ts`). A frame over 1 MiB closes the whole
 *   connection, and 512 KiB of raw bytes is about 700 KiB of base64.
 * - `MAX_PASTED_IMAGE_BYTES` sits below the daemon's 20 MiB `writeFile` cap
 *   (`electron/terminal-host/index.ts`).
 */

export const MAX_PASTED_IMAGE_BYTES = 16 * 1024 * 1024;

export const PASTED_IMAGE_CHUNK_BYTES = 512 * 1024;

const PASTED_IMAGE_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;

/** The file extension for an image MIME type, or null if it isn't accepted. */
export function pastedImageExtension(mime: string): string | null {
  return Object.prototype.hasOwnProperty.call(PASTED_IMAGE_TYPES, mime)
    ? PASTED_IMAGE_TYPES[mime as keyof typeof PASTED_IMAGE_TYPES]
    : null;
}
