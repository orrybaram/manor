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

/** The most a window grows to, to hold a line longer than itself. */
const JSONL_WINDOW_MAX_BYTES = 4 * 1024 * 1024;

const NEWLINE = 0x0a;

export interface JsonlWindows {
  /** Records from the top, in file order. */
  head: unknown[];
  /** Records from the bottom, in file order; the same records as `head` for a small file. */
  tail: unknown[];
  /**
   * A window stopped growing at its cap inside one line, so a record that
   * should be there may be missing: a summary should not be dropped for
   * what isn't seen.
   */
  capped: boolean;
}

/**
 * Parsed lines of `bytes`. A line the window cut (the first, when
 * `cutStart`; the last, when it ends mid-file) is dropped, as is any line
 * that is not JSON: a writer may be mid-append.
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

/**
 * The records in the first and last `windowBytes` of the file at `path`,
 * which is `size` long. A window grows to hold a line longer than itself,
 * up to `maxBytes`: the head reads on to the end of the line its window
 * cut, so a long first prompt is whole; the tail reads back while a cut
 * line fills most of it, so a long last record leaves the ones before it.
 */
export async function readJsonlWindows(
  path: string,
  size: number,
  windowBytes = JSONL_WINDOW_BYTES,
  maxBytes = Math.max(JSONL_WINDOW_MAX_BYTES, windowBytes),
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
      return { head: all, tail: all, capped: false };
    }
    let capped = false;

    // The head, on to the end of the line its window cut: until a line break at or after its last byte.
    let headBytes = await read(0, windowBytes);
    let searchFrom = headBytes.length - 1;
    let step = windowBytes;
    while (headBytes.indexOf(NEWLINE, searchFrom) < 0 && headBytes.length < size) {
      if (headBytes.length >= maxBytes) {
        capped = true;
        break;
      }
      const chunk = await read(headBytes.length, Math.min(step, maxBytes - headBytes.length, size - headBytes.length));
      if (chunk.length === 0) break;
      searchFrom = headBytes.length;
      headBytes = Buffer.concat([headBytes, chunk]);
      step *= 2;
    }
    const head = records(headBytes, false);

    // The tail, back while the line its window cut fills more than half of it.
    let tailStart = size - windowBytes;
    let tailBytes = await read(tailStart, windowBytes);
    for (;;) {
      const firstBreak = tailBytes.indexOf(NEWLINE);
      const whole = firstBreak < 0 ? 0 : tailBytes.length - firstBreak - 1;
      if (tailStart === 0 || whole >= windowBytes / 2) break;
      if (size - tailStart >= maxBytes) {
        capped = true;
        break;
      }
      const from = Math.max(0, size - Math.min((size - tailStart) * 2, maxBytes));
      tailBytes = Buffer.concat([await read(from, tailStart - from), tailBytes]);
      tailStart = from;
    }
    const tail = records(tailBytes, tailStart > 0);
    return { head, tail, capped };
  } finally {
    await file.close();
  }
}
