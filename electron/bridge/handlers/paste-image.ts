/**
 * A browser's pasted image, uploaded into a pane's host, as the
 * `pasteImage` namespace of the handler table.
 *
 * The bridge is JSON text with a 1 MiB frame cap, so the bytes arrive as
 * base64 chunks: `begin` opens an upload, `chunk` appends each piece in
 * order, and `commit` writes the whole image once through
 * `writePastedImage` and answers its path. Nothing touches the host until
 * then, so a reader never sees a partial file.
 *
 * Staging is this module's memory, bounded whatever the client does: an
 * upload id is 128 random bits bound to the caller that opened it, a caller
 * holds at most `MAX_UPLOADS_PER_CALLER`, all callers together at most
 * `MAX_STAGED_BYTES`, and an upload idle for `UPLOAD_IDLE_MS` is swept.
 */

import crypto from "node:crypto";
import {
  assertNonNegativeInt,
  assertPositiveInt,
  assertString,
} from "../../ipc-validate";
import { LOCAL_HOST_ID } from "../../backend/types";
import type { BackendRegistry } from "../../backend/registry";
import type { PaneHostLookup } from "../../agent-persistence";
import { writePastedImage } from "../../server/pasted-images";
import {
  MAX_PASTED_IMAGE_BYTES,
  PASTED_IMAGE_CHUNK_BYTES,
  pastedImageExtension,
} from "../../../src/lib/pasted-image";
import { byPane, method, type HandlerCtx } from "../method";

/** How many uploads one caller may have open at once. */
export const MAX_UPLOADS_PER_CALLER = 4;
/** The declared bytes of every open upload, across all callers. */
const MAX_STAGED_BYTES = 128 * 1024 * 1024;
/** An upload with no chunk for this long is dropped. */
export const UPLOAD_IDLE_MS = 60_000;
const SWEEP_INTERVAL_MS = 15_000;

/** The longest base64 a full chunk encodes to, with slack for padding. */
const MAX_CHUNK_BASE64 = 4 * Math.ceil(PASTED_IMAGE_CHUNK_BYTES / 3) + 4;

/**
 * What the `pasteImage` namespace reads: the registry to write through and
 * the pane's host, nothing else — so the host server serves the same
 * handlers.
 */
export interface PasteImageDeps {
  backendRegistry: Pick<BackendRegistry, "get">;
  getPaneHostId: PaneHostLookup;
}

export interface PasteImageBegin {
  uploadId: string;
}

export interface PasteImageCommit {
  path: string;
}

/**
 * The host of an upload for a pane no layout holds yet: the phone's
 * new-agent composer uploads before its agent's pane exists. Every method
 * takes it, so the whole upload routes to the same server.
 */
export interface PasteImageTarget {
  hostId?: string;
}

/** `target.hostId`, if the caller named one. */
function namedHost(target: PasteImageTarget | undefined): string | null {
  const hostId = target && typeof target === "object" ? target.hostId : undefined;
  return typeof hostId === "string" && hostId ? hostId : null;
}

interface Upload {
  id: string;
  callerId: string;
  paneId: string;
  hostId: string;
  ext: string;
  /** Declared up front; staging is counted against it, not `received`. */
  size: number;
  parts: Buffer[];
  received: number;
  touched: number;
}

const uploads = new Map<string, Upload>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function drop(uploadId: string): void {
  uploads.delete(uploadId);
  if (uploads.size === 0 && sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

function sweep(): void {
  const cutoff = Date.now() - UPLOAD_IDLE_MS;
  for (const upload of [...uploads.values()]) {
    if (upload.touched < cutoff) drop(upload.id);
  }
}

/**
 * The caller's own upload for this pane. Anything else — an expired id,
 * another caller's, another pane's — reads the same, so an id leaks nothing.
 */
function owned(ctx: HandlerCtx<unknown>, paneId: string, uploadId: string): Upload {
  const upload = uploads.get(uploadId);
  if (!upload || upload.callerId !== ctx.caller.id || upload.paneId !== paneId) {
    throw new Error("Unknown upload");
  }
  return upload;
}

function stagedBytes(): number {
  let total = 0;
  for (const upload of uploads.values()) total += upload.size;
  return total;
}

export function pasteImageBegin(
  ctx: HandlerCtx<PasteImageDeps>,
  paneId: string,
  image: { mime: string; size: number },
  target?: PasteImageTarget,
): PasteImageBegin {
  assertString(paneId, "paneId");
  if (!image || typeof image !== "object") {
    throw new Error("image: expected { mime, size }");
  }
  assertString(image.mime, "image.mime");
  assertPositiveInt(image.size, "image.size");
  const ext = pastedImageExtension(image.mime);
  if (!ext) throw new Error(`Unsupported image type: ${image.mime}`);
  if (image.size > MAX_PASTED_IMAGE_BYTES) {
    throw new Error(
      `Image is too large (over ${MAX_PASTED_IMAGE_BYTES / (1024 * 1024)} MB)`,
    );
  }

  let mine = 0;
  for (const upload of uploads.values()) {
    if (upload.callerId === ctx.caller.id) mine++;
  }
  if (
    mine >= MAX_UPLOADS_PER_CALLER ||
    stagedBytes() + image.size > MAX_STAGED_BYTES
  ) {
    throw new Error("Too many uploads in progress");
  }

  const upload: Upload = {
    id: crypto.randomBytes(16).toString("hex"),
    callerId: ctx.caller.id,
    paneId,
    hostId: ctx.deps.getPaneHostId(paneId) ?? namedHost(target) ?? LOCAL_HOST_ID,
    ext,
    size: image.size,
    parts: [],
    received: 0,
    touched: Date.now(),
  };
  uploads.set(upload.id, upload);
  if (!sweepTimer) {
    sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }
  return { uploadId: upload.id };
}

export function pasteImageChunk(
  ctx: HandlerCtx<PasteImageDeps>,
  paneId: string,
  uploadId: string,
  index: number,
  base64: string,
  _target?: PasteImageTarget,
): void {
  assertString(paneId, "paneId");
  assertString(uploadId, "uploadId");
  const upload = owned(ctx, paneId, uploadId);
  // Past ownership, a bad chunk leaves the upload unfinishable: drop it so
  // its bytes stop counting against the limits.
  try {
    assertNonNegativeInt(index, "index");
    assertString(base64, "chunk");
    if (index !== upload.parts.length) {
      throw new Error(`Image chunk out of order (got ${index}, expected ${upload.parts.length})`);
    }
    // Before decoding, so an oversized string is never copied into a Buffer.
    if (base64.length > MAX_CHUNK_BASE64) throw new Error("Image chunk is too large");
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length > PASTED_IMAGE_CHUNK_BYTES) throw new Error("Image chunk is too large");
    if (upload.received + bytes.length > upload.size) {
      throw new Error("Image is larger than declared");
    }
    upload.parts.push(bytes);
    upload.received += bytes.length;
    upload.touched = Date.now();
  } catch (err) {
    drop(upload.id);
    throw err;
  }
}

export async function pasteImageCommit(
  ctx: HandlerCtx<PasteImageDeps>,
  paneId: string,
  uploadId: string,
  _target?: PasteImageTarget,
): Promise<PasteImageCommit> {
  assertString(paneId, "paneId");
  assertString(uploadId, "uploadId");
  const upload = owned(ctx, paneId, uploadId);
  // Dropped before the write is awaited, so a second commit (or a late
  // chunk) for this id is "Unknown upload" and the file is written once.
  drop(upload.id);
  if (upload.received !== upload.size) {
    throw new Error(
      `Image upload is incomplete (${upload.received} of ${upload.size} bytes)`,
    );
  }
  const path = await writePastedImage(
    ctx.deps.backendRegistry,
    upload.hostId,
    Buffer.concat(upload.parts),
    upload.ext,
  );
  return { path };
}

/** The client gave up; drops the upload if it is the caller's. Never throws. */
export function pasteImageAbort(
  ctx: HandlerCtx<PasteImageDeps>,
  paneId: string,
  uploadId: string,
  _target?: PasteImageTarget,
): void {
  const upload = typeof uploadId === "string" ? uploads.get(uploadId) : undefined;
  if (upload && upload.callerId === ctx.caller.id && upload.paneId === paneId) {
    drop(upload.id);
  }
}

/** Clears staging and the sweep, between tests. */
export function _resetPasteImageUploadsForTests(): void {
  uploads.clear();
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

/** How many uploads are staged, for tests. */
export function _stagedUploadCountForTests(): number {
  return uploads.size;
}

/**
 * Routed by pane: the pane's own server stages the upload and writes the
 * file, on the desktop a pane on an adopted host forwarded to that host's
 * server. Only `commit` is audited, with the pane as target: chunks would add
 * 32 lines per paste, and bodies are never recorded anyway. A pane no layout
 * holds yet routes by the trailing `PasteImageTarget`.
 */
export const pasteImage = {
  begin: method(pasteImageBegin, { route: byPane(0, 2) }),
  chunk: method(pasteImageChunk, { route: byPane(0, 4) }),
  commit: method(pasteImageCommit, { mutating: true, route: byPane(0, 2) }),
  abort: method(pasteImageAbort, { route: byPane(0, 2) }),
};
