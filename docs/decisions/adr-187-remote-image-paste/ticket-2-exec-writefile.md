---
title: Add writeFile to Exec and ShellBackend with a chunked-exec fallback
status: done
priority: high
assignee: opus
blocked_by: [1]
---

# Add writeFile to Exec and ShellBackend with a chunked-exec fallback

See ADR-187 §2.

- `Exec` interface (`electron/backend/exec.ts`): add `writeFile(path: string, data: Buffer): Promise<void>`. For `localExec`, use `fs.promises.mkdir(path.dirname(p), { recursive: true })` and then `fs.promises.writeFile(p, data)`.
- `createRemoteExec` (`electron/backend/remote-exec.ts`): add `"writeFile"` to `RemoteExecClient`'s Pick. Call `client.writeFile(path, data)`. If it rejects with a message containing `unknown request type`, set a closure flag `daemonLacksWriteFile = true` and use the fallback. Later calls go straight to the fallback. Other errors propagate.
- Fallback, all through `client.exec`:
  1. `sh -c 'mkdir -p "$(dirname "$1")" && : > "$1"' sh <tmp>`
  2. For each 64 KiB slice of `data.toString("base64")` (slice on a multiple of 4 chars), run `sh -c 'printf %s "$1" | base64 -d >> "$2"' sh <chunk> <tmp>`.
  3. `mv -f <tmp> <path>`.

  `<tmp>` is `${path}.upload.tmp`. A non-zero exit code throws an ExecError built with `execError`. If a step fails, make a best-effort `rm -f <tmp>`. Update the file header's "Differences" comment.
- Any other `Exec` implementations or test fakes (grep for `readFile(path` implementations of `Exec`) need a `writeFile` too so typecheck passes.
- `ShellBackend` (`electron/backend/types.ts`): add `writeFile(path: string, data: Buffer): Promise<void>` with JSDoc. `ExecShellBackend` delegates it to its exec. Update any other `ShellBackend` implementations, stubs, and host-view wrappers (`electron/backend/host-view.ts`) so a host that is away throws `HostUnavailableError`, like the other shell methods.
- Tests in `remote-exec.test.ts` (create it if missing, following the existing backend test style): the primary path calls `client.writeFile`. On an `unknown request type` error it falls back and the chunks reassemble to the original bytes; simulate `exec` with a fake that applies the commands to an in-memory buffer, or just assert the argument sequence. A second call skips `writeFile`.

## Files to touch
- `electron/backend/exec.ts`
- `electron/backend/remote-exec.ts` (+ test)
- `electron/backend/types.ts`
- `electron/backend/exec-shell.ts`
- `electron/backend/host-view.ts` and any other ShellBackend/Exec implementers or fakes
