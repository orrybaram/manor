/**
 * NDJSON line reading for the daemon's sockets, in both directions.
 */

import { StringDecoder } from "node:string_decoder";

/**
 * Returns a `data` handler that calls `onLine` with every complete, non-blank
 * line it reads.
 *
 * Only each new chunk is scanned for newlines; the unfinished line is kept as
 * a list of pieces and joined once, when its newline arrives. Re-splitting the
 * whole pending buffer on every chunk instead is quadratic in the length of a
 * line, and a snapshot reply is one line several megabytes long arriving in
 * 64 KB chunks.
 *
 * A multi-byte character split across two chunks is decoded whole.
 */
export function createLineReader(
  onLine: (line: string) => void,
): (chunk: Buffer) => void {
  const decoder = new StringDecoder("utf8");
  let pending: string[] = [];
  return (chunk: Buffer) => {
    const text = decoder.write(chunk);
    let start = 0;
    let newline = text.indexOf("\n");
    while (newline !== -1) {
      let line = text.slice(start, newline);
      if (pending.length > 0) {
        pending.push(line);
        line = pending.join("");
        pending = [];
      }
      if (line.trim()) onLine(line);
      start = newline + 1;
      newline = text.indexOf("\n", start);
    }
    if (start < text.length) pending.push(text.slice(start));
  };
}
