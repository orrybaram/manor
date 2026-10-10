/**
 * Where the chat mirror reads a transcript from (ADR-216 D1).
 *
 * The mirror owns the offset bookkeeping; a source only answers "the bytes
 * from here to the end, and how big is the file now".
 */

import fs from "node:fs";

export type TranscriptRead =
  | {
      ok: true;
      size: number;
      data: string;
      /**
       * The line at the offset is too long to read, and is complete: it is
       * this many bytes, newline included. `data` is empty; the mirror steps
       * over the line without an entry and reads on (ADR-216 ticket 3).
       */
      skip?: number;
    }
  | { ok: false; error: string };

export interface TranscriptSource {
  /**
   * The bytes from `offset` to the current end, decoded as UTF-8, and the
   * file's size in bytes now. A missing file is size 0 with no data.
   */
  read(path: string, offset: number): Promise<TranscriptRead>;
  /** Optional change signal. Absent for sources that are poked or polled instead. */
  watch?(path: string, onChange: () => void): () => void;
}

/** Reads are chunked so a long transcript never needs one huge buffer. */
const READ_CHUNK_BYTES = 1 << 20;

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
      const chunks: Buffer[] = [];
      let at = offset;
      while (at < size) {
        const length = Math.min(size - at, READ_CHUNK_BYTES);
        const chunk = Buffer.alloc(length);
        const { bytesRead } = await handle.read(chunk, 0, length, at);
        if (bytesRead === 0) break;
        at += bytesRead;
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return { ok: true, size, data: Buffer.concat(chunks).toString("utf8") };
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
