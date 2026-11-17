import fs from "node:fs";

/** Bytes read per chunk: a big transcript is never held whole. */
const CHUNK_BYTES = 256 * 1024;
const NEWLINE = 0x0a;

/**
 * Calls `onLine` for each complete line of a JSONL file after byte `offset`,
 * reading in chunks, and returns the offset just past the last complete line.
 * A trailing line with no newline yet is left for the next scan. A missing
 * file scans nothing; a file now shorter than `offset` resumes at its end. `onLine` returning "stop" ends the scan after that line.
 */
export async function scanJsonlLines(
  file: string,
  offset: number,
  onLine: (line: string) => void | "stop",
): Promise<number> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, "r");
  } catch {
    return offset;
  }
  try {
    const { size } = await handle.stat();
    // A file cut shorter than the offset starts again at its new end.
    if (size <= offset) return size;
    let position = offset;
    /** Bytes of a line that began in an earlier chunk. */
    let carry: Buffer = Buffer.alloc(0);
    let consumed = offset;
    const chunk = Buffer.alloc(CHUNK_BYTES);
    while (position < size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(CHUNK_BYTES, size - position), position);
      if (bytesRead === 0) break;
      position += bytesRead;
      let start = 0;
      for (let i = 0; i < bytesRead; i++) {
        if (chunk[i] !== NEWLINE) continue;
        const piece = chunk.subarray(start, i);
        const line = carry.length > 0 ? Buffer.concat([carry, piece]) : piece;
        carry = Buffer.alloc(0);
        consumed += line.length + 1;
        start = i + 1;
        if (line.length > 0 && onLine(line.toString("utf8")) === "stop") return consumed;
      }
      if (start < bytesRead) carry = Buffer.concat([carry, chunk.subarray(start, bytesRead)]);
    }
    return consumed;
  } finally {
    await handle.close();
  }
}

/** The file's size, or 0 when it is gone. */
export async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.promises.stat(file)).size;
  } catch {
    return 0;
  }
}

/**
 * When a JSONL file was created: its birth time, else (on a filesystem
 * without one) its first line's `timestamp`; null when it is gone or neither
 * says.
 */
export async function jsonlCreatedAt(file: string): Promise<number | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return null;
  }
  if (stat.birthtimeMs > 0) return stat.birthtimeMs;
  let first: number | null = null;
  await scanJsonlLines(file, 0, (line) => {
    const match = /"timestamp":"([^"]+)"/.exec(line);
    const at = match ? Date.parse(match[1]) : NaN;
    if (Number.isNaN(at)) return;
    first = at;
    return "stop";
  }).catch(() => undefined);
  return first;
}

/** A parsed line's object, not an array or a scalar. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A token count from a usage field: a finite positive number, else 0. */
export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
