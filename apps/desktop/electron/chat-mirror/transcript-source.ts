/**
 * Where the chat mirror reads a transcript from.
 *
 * The mirror owns the offset bookkeeping; a source only answers "the next
 * window of bytes from here, and how big is the file now". The mirror reads
 * window after window until it reaches the end.
 */

import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

export type TranscriptRead =
  | {
      ok: true;
      size: number;
      /**
       * The bytes from the offset, decoded as UTF-8: at most one read window,
       * ending on a complete line unless the window reaches the end of the
       * file. The caller reads again from where it got to for the rest.
       */
      data: string;
      /**
       * The line at the offset is too long to read, and is complete: it is
       * this many bytes, newline included. `data` is empty; the mirror steps
       * over the line and reads on.
       */
      skip?: number;
      /**
       * With `skip`: the skipped line's first and last few KiB, for its
       * parser to name what it was. Which fields come first varies.
       */
      head?: string;
      tail?: string;
    }
  | { ok: false; error: string };

export interface TranscriptSource {
  /**
   * Up to one window of bytes from `offset`, decoded as UTF-8, and the
   * file's size in bytes now. A missing file is size 0 with no data.
   */
  read(path: string, offset: number): Promise<TranscriptRead>;
  /** Optional change signal. Absent for sources that are poked or polled instead. */
  watch?(path: string, onChange: () => void): () => void;
}

/** The most one read returns, so a long transcript never needs one huge buffer. */
export const READ_WINDOW_BYTES = 8 << 20;
/** A line longer than this is skipped, not read: a huge tool output, say. */
export const MAX_RECORD_BYTES = 2 << 20;
/** How much of each end of a skipped line its parser sees. */
const OVERSIZED_EDGE_BYTES = 4 << 10;
/** The step a search for a skipped line's end reads in. */
const SCAN_CHUNK_BYTES = 1 << 20;

/** The transcript on this machine's filesystem. */
export class LocalTranscriptSource implements TranscriptSource {
  async read(path: string, offset: number): Promise<TranscriptRead> {
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(path, "r");
    } catch {
      return { ok: true, size: 0, data: "" }; // Not written yet.
    }
    try {
      const { size } = await handle.stat();
      if (offset >= size) return { ok: true, size, data: "" };
      const length = Math.min(size - offset, READ_WINDOW_BYTES);
      const window = Buffer.alloc(length);
      const got = await readFully(handle, window, offset);
      const bytes = window.subarray(0, got);
      const first = bytes.indexOf(0x0a);
      // The line at the offset is longer than a record may be.
      if (first === -1 ? got > MAX_RECORD_BYTES : first >= MAX_RECORD_BYTES) {
        // Decoded now: the search below reuses the window's buffer.
        const head = new StringDecoder("utf8").write(bytes.subarray(0, OVERSIZED_EDGE_BYTES));
        const end = first !== -1 ? offset + first : await findNewline(handle, offset + got, size, window);
        // Still being written: wait for its end without holding any of it.
        if (end === -1) return { ok: true, size, data: "" };
        const tailStart = Math.max(offset, end - OVERSIZED_EDGE_BYTES);
        const tailBytes = window.subarray(0, end - tailStart);
        const tailGot = await readFully(handle, tailBytes, tailStart);
        // It may start mid-character; the replacement character is harmless.
        const tail = tailBytes.subarray(0, tailGot).toString("utf8");
        return { ok: true, size, data: "", skip: end - offset + 1, head, tail };
      }
      return { ok: true, size, data: bytes.subarray(0, readableEnd(bytes, offset + got === size)).toString("utf8") };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await handle.close();
    }
  }

  watch(path: string, onChange: () => void): () => void {
    let watcher: fs.FSWatcher | null = null;
    try {
      watcher = fs.watch(path, { persistent: false }, onChange);
      watcher.on("error", () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      // Not there yet, or not watchable: the caller's poll covers it.
      watcher = null;
    }
    return () => {
      watcher?.close();
      watcher = null;
    };
  }
}

/**
 * How much of a window to return: up to the first line too long to read,
 * which the next read skips; else up to the last whole line, or all of it
 * at the end of the file (a partial last line waits for its newline).
 */
function readableEnd(bytes: Buffer, atEof: boolean): number {
  let lineStart = 0;
  for (;;) {
    const nl = bytes.indexOf(0x0a, lineStart);
    if (nl === -1) {
      if (bytes.length - lineStart > MAX_RECORD_BYTES) return lineStart;
      return atEof ? bytes.length : lineStart;
    }
    if (nl - lineStart >= MAX_RECORD_BYTES) return lineStart;
    lineStart = nl + 1;
  }
}

/** Fill `buffer` from `position`, short only at the end of the file. */
async function readFully(handle: fs.promises.FileHandle, buffer: Buffer, position: number): Promise<number> {
  let got = 0;
  while (got < buffer.length) {
    const { bytesRead } = await handle.read(buffer, got, buffer.length - got, position + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return got;
}

/**
 * The position of the first newline at or after `from` and before `size`,
 * or -1. Reads through `scratch` a chunk at a time, so a long line is never
 * held whole.
 */
async function findNewline(
  handle: fs.promises.FileHandle,
  from: number,
  size: number,
  scratch: Buffer,
): Promise<number> {
  const chunk = scratch.subarray(0, Math.min(scratch.length, SCAN_CHUNK_BYTES));
  let at = from;
  while (at < size) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - at), at);
    if (bytesRead === 0) break;
    const i = chunk.subarray(0, bytesRead).indexOf(0x0a);
    if (i !== -1) return at + i;
    at += bytesRead;
  }
  return -1;
}
