/**
 * A transcript on a remote host, read through that host's `Exec`
 * (ADR-216 D2).
 *
 * One short `sh -c` per read prints the file's byte size on the first line,
 * then the bytes from the offset on, at most `MAX_READ_BYTES` of them. The
 * path and the offset are positional arguments, never part of the script.
 * The output comes back as a UTF-8 string; the mirror only advances its
 * offset by the byte length of complete lines, so a character split by the
 * cap can only fall in the partial tail line, which is read again later.
 *
 * A single line longer than the cap would never complete within one read,
 * stalling the chat for good (a large tool result, a base64 image). When a
 * capped read holds no newline, a second script measures that line on the
 * remote, streaming, and the read answers `skip` with its length: the mirror
 * steps over it without an entry.
 *
 * There is no `watch`: the remote file is read when the mirror is poked or
 * polled. Nothing runs on the remote between reads.
 */

import type { Exec } from "../backend/exec";
import { errorMessage } from "../lib/errors";
import type { TranscriptRead, TranscriptSource } from "./transcript-source";

/** What a remote read needs of an `Exec`. */
export type TranscriptExec = Pick<Exec, "file">;

/** The most bytes one read returns. A longer backlog takes several reads. */
export const MAX_READ_BYTES = 4 * 1024 * 1024;

/**
 * `$1` is the path, `$2` the offset. A missing file is size 0. `head -c`
 * caps the tail at the size just measured (and at `cap`), so bytes appended
 * mid-read wait for the next read rather than slipping past the reported
 * size. `$(( ))` around `wc` trims the padding BSD `wc` adds.
 */
function readScript(cap: number): string {
  return `if [ -e "$1" ]; then size=$(( $(wc -c < "$1") )); else size=0; fi
printf '%s\\n' "$size"
want=$(( size - $2 ))
if [ "$want" -gt ${cap} ]; then want=${cap}; fi
if [ "$want" -gt 0 ]; then tail -c +$(( $2 + 1 )) "$1" | head -c "$want"; fi`;
}

export const READ_SCRIPT = readScript(MAX_READ_BYTES);

/**
 * The line starting at byte `$2` of `$1`: how many newlines it holds (1 if
 * it is complete, 0 if it is still being written) and its byte length,
 * newline included. POSIX `wc` prints lines before bytes whatever the flag
 * order. Only the two counts come back, however long the line is.
 */
export const LINE_LENGTH_SCRIPT = `tail -c +$(( $2 + 1 )) "$1" | head -n 1 | wc -lc`;

const READ_TIMEOUT_MS = 10_000;
/** Room for `MAX_READ_BYTES` plus the size line, counted in characters. */
const READ_MAX_BUFFER = 8 * 1024 * 1024;

export interface RemoteTranscriptSourceOptions {
  /** The most bytes one read returns. Default `MAX_READ_BYTES`; tests shrink it. */
  maxReadBytes?: number;
}

export class RemoteTranscriptSource implements TranscriptSource {
  private readonly maxReadBytes: number;
  private readonly script: string;

  /** `getExec` answers null while the host cannot be reached. */
  constructor(
    private readonly getExec: () => TranscriptExec | null,
    options: RemoteTranscriptSourceOptions = {},
  ) {
    this.maxReadBytes = options.maxReadBytes ?? MAX_READ_BYTES;
    this.script = readScript(this.maxReadBytes);
  }

  async read(path: string, offset: number): Promise<TranscriptRead> {
    const exec = this.getExec();
    if (!exec) return { ok: false, error: "host offline" };
    let stdout: string;
    try {
      ({ stdout } = await exec.file(
        "sh",
        ["-c", this.script, "sh", path, String(offset)],
        { timeout: READ_TIMEOUT_MS, maxBuffer: READ_MAX_BUFFER },
      ));
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
    const eol = stdout.indexOf("\n");
    const head = eol === -1 ? stdout : stdout.slice(0, eol);
    if (!/^\d+$/.test(head.trim())) {
      return { ok: false, error: `unexpected transcript size: ${JSON.stringify(head.slice(0, 80))}` };
    }
    const size = Number(head.trim());
    const data = eol === -1 ? "" : stdout.slice(eol + 1);
    // Capped with no newline in it: the line at `offset` is longer than one
    // read can hold, and would never complete. Measure it and step over it.
    if (size - offset > this.maxReadBytes && !data.includes("\n")) {
      return this.skipLongLine(exec, path, offset, size, data);
    }
    return { ok: true, size, data };
  }

  /**
   * The read for an over-long line at `offset`: `skip` its length once it is
   * complete, or the plain (newline-less) read while it is still being
   * written, which the mirror leaves for later as any partial line.
   */
  private async skipLongLine(
    exec: TranscriptExec,
    path: string,
    offset: number,
    size: number,
    data: string,
  ): Promise<TranscriptRead> {
    let stdout: string;
    try {
      ({ stdout } = await exec.file(
        "sh",
        ["-c", LINE_LENGTH_SCRIPT, "sh", path, String(offset)],
        { timeout: READ_TIMEOUT_MS },
      ));
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
    const counts = /^\s*(\d+)\s+(\d+)\s*$/.exec(stdout);
    if (!counts) {
      return { ok: false, error: `unexpected line length: ${JSON.stringify(stdout.slice(0, 80))}` };
    }
    const complete = Number(counts[1]) === 1;
    const length = Number(counts[2]);
    if (!complete || length <= 0) return { ok: true, size, data };
    console.warn(
      `[chat-mirror] skipping a ${length}-byte transcript line at ${offset} in ${path}: too large to show`,
    );
    return { ok: true, size, data: "", skip: length };
  }
}
