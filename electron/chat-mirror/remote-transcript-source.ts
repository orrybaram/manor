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
 * caps the tail at the size just measured, so bytes appended mid-read wait
 * for the next read rather than slipping past the reported size. `$(( ))`
 * around `wc` trims the padding BSD `wc` adds.
 */
export const READ_SCRIPT = `if [ -e "$1" ]; then size=$(( $(wc -c < "$1") )); else size=0; fi
printf '%s\\n' "$size"
want=$(( size - $2 ))
if [ "$want" -gt ${MAX_READ_BYTES} ]; then want=${MAX_READ_BYTES}; fi
if [ "$want" -gt 0 ]; then tail -c +$(( $2 + 1 )) "$1" | head -c "$want"; fi`;

const READ_TIMEOUT_MS = 10_000;
/** Room for `MAX_READ_BYTES` plus the size line, counted in characters. */
const READ_MAX_BUFFER = 8 * 1024 * 1024;

export class RemoteTranscriptSource implements TranscriptSource {
  /** `getExec` answers null while the host cannot be reached. */
  constructor(private readonly getExec: () => TranscriptExec | null) {}

  async read(path: string, offset: number): Promise<TranscriptRead> {
    const exec = this.getExec();
    if (!exec) return { ok: false, error: "host offline" };
    let stdout: string;
    try {
      ({ stdout } = await exec.file(
        "sh",
        ["-c", READ_SCRIPT, "sh", path, String(offset)],
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
    return { ok: true, size, data: eol === -1 ? "" : stdout.slice(eol + 1) };
  }
}
