/**
 * Uploads an image pasted in the browser into a pane's host,
 * through the `pasteImage` namespace: `begin`, each chunk in order, `commit`.
 */

import {
  MAX_PASTED_IMAGE_BYTES,
  PASTED_IMAGE_CHUNK_BYTES,
  pastedImageExtension,
} from "./pasted-image";

/** A paste that can't go through; its message is shown to the user. */
export class PasteImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasteImageError";
  }
}

export interface UploadPastedImageOptions {
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  /**
   * The host to upload to when `paneId` is in no layout yet (the new-agent
   * composer's, before its agent starts).
   */
  hostId?: string;
}

/** The blob's bytes as base64, without `btoa` on a large string. */
function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read image"));
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** Uploads the image and resolves to its path on the pane's host. */
export async function uploadPastedImage(
  paneId: string,
  blob: Blob,
  opts?: UploadPastedImageOptions,
): Promise<string> {
  if (!pastedImageExtension(blob.type)) {
    throw new PasteImageError("Only PNG, JPEG, GIF and WebP images can be pasted");
  }
  if (blob.size > MAX_PASTED_IMAGE_BYTES) {
    throw new PasteImageError(
      `Image is too large (${formatMiB(blob.size)} MiB; the limit is ${MAX_PASTED_IMAGE_BYTES / (1024 * 1024)} MiB)`,
    );
  }

  const api = window.electronAPI.pasteImage;
  // Only when named, so a placed pane's calls stay as they were.
  const target = opts?.hostId ? [{ hostId: opts.hostId }] : [];
  const { uploadId } = await api.begin(
    paneId,
    { mime: blob.type, size: blob.size },
    ...target,
  );
  try {
    let index = 0;
    let sent = 0;
    for (let off = 0; off < blob.size; off += PASTED_IMAGE_CHUNK_BYTES) {
      const piece = blob.slice(off, off + PASTED_IMAGE_CHUNK_BYTES);
      await api.chunk(paneId, uploadId, index++, await toBase64(piece), ...target);
      sent += piece.size;
      opts?.onProgress?.(sent, blob.size);
    }
    const { path } = await api.commit(paneId, uploadId, ...target);
    return path;
  } catch (err) {
    await api.abort(paneId, uploadId, ...target).catch(() => {});
    throw err;
  }
}
