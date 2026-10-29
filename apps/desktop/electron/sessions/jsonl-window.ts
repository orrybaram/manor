/**
 * The head and tail of a JSONL transcript, without reading the middle.
 *
 * Listing a store means a few facts per file: who, where and when sit near
 * the top, the latest title and model near the bottom. Reading two windows
 * keeps a scan of hundreds of megabytes to a fraction of a second.
 */

import { open } from "node:fs/promises";

/** Bytes read from each end. */
const JSONL_WINDOW_BYTES = 64 * 1024;

export interface JsonlWindows {
  /** Records from the top, in file order. */
  head: unknown[];
  /** Records from the bottom, in file order; the same records as `head` for a small file. */
  tail: unknown[];
}

/**
 * Parsed lines of `bytes` read from `start`. A line the window cut (the
 * first, when it starts mid-file; the last, when it ends mid-file) is
 * dropped, as is any line that is not JSON: a writer may be mid-append.
 */
function records(bytes: Buffer, cutStart: boolean): unknown[] {
  const lines = bytes.toString("utf8").split("\n");
  if (cutStart) lines.shift();
  const out: unknown[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A cut or half-written line.
    }
  }
  return out;
}

/** The records in the first and last `windowBytes` of the file at `path`, which is `size` long. */
export async function readJsonlWindows(
  path: string,
  size: number,
  windowBytes = JSONL_WINDOW_BYTES,
): Promise<JsonlWindows> {
  const file = await open(path, "r");
  try {
    const read = async (start: number, length: number): Promise<Buffer> => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await file.read(buf, 0, length, start);
      return buf.subarray(0, bytesRead);
    };
    if (size <= windowBytes * 2) {
      const all = records(await read(0, size), false);
      return { head: all, tail: all };
    }
    // A head line cut at the window's end fails to parse and is dropped.
    const head = records(await read(0, windowBytes), false);
    const tail = records(await read(size - windowBytes, windowBytes), true);
    return { head, tail };
  } finally {
    await file.close();
  }
}
