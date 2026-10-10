---
title: RemoteTranscriptSource over the host's Exec
status: done
priority: high
assignee: opus
blocked_by: [1]
---

# RemoteTranscriptSource over the host's Exec

ADR-216 D2. Read the ADR and `electron/backend/exec.ts` (the `Exec` interface), `remote-exec.ts`, and how `backendRegistry.get(hostId)` exposes a host's exec.

1. `electron/chat-mirror/remote-transcript-source.ts` exports `RemoteTranscriptSource` with `constructor(getExec: () => Exec | null)`.
   - `read(path, offset)` runs `exec.file("sh", ["-c", SCRIPT, "sh", path, String(offset)], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })`.
   - `SCRIPT` is POSIX sh. It:
     - prints `wc -c < "$1"` (trimmed; `0` when the file is missing);
     - prints a newline;
     - if the size is greater than `$2`, prints `tail -c +$(( $2 + 1 )) "$1" | head -c $(( size - $2 ))`.
   - Cap a single read: if `size - offset` is over 4 MiB, read only 4 MiB. The mirror reads again on the next trigger.
   - Parse the first line as the size. The rest is `data`.
   - A missing exec (host offline), a rejected promise, a timeout, or a size that isn't a number → `{ ok: false, error }`. Never throw.
   - No `watch`.
2. In `mirror.ts`:
   - `sourceFor(agent)` returns the remote source for `agent.hostId !== LOCAL_HOST_ID`, built from the backend registry.
   - A `{ ok: false }` read surfaces as the new `ChatUnavailableReason` `"host-offline"` for `getHistory` (add it to the type). For live subscribers, keep the last good entries and retry on the next trigger.
3. Verify the script with a quick local spike. Run the exact `sh -c` against a temp file on this Mac, under both `/bin/sh` and `bash --posix`. Cover:
   - a missing file
   - offset 0
   - a mid-file offset
   - an offset at the end
   - a file that shrank
   - a file with multi-byte UTF-8 (emoji, CJK) where the offset falls just before a multi-byte line
   Put this in a unit test that runs the real script through a local `Exec` (`localExec`), so it stays pinned.
4. Unit-test `RemoteTranscriptSource` with a fake `Exec` for the error paths, and through the mirror for the offset accounting: two reads that split a multi-byte line must yield the right entries and the right final offset.

## Files to touch
- `electron/chat-mirror/remote-transcript-source.ts` — new (+ tests)
- `electron/chat-mirror/mirror.ts` — the source choice, the `host-offline` reason
- `electron/chat-mirror/__tests__/*` — tests
