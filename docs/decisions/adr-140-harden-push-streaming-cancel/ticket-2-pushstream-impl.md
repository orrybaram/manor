---
title: Implement LocalGitBackend.pushStream with spawn, line buffering, and cancel
status: done
priority: critical
assignee: opus
blocked_by: [1]
---

# Ticket 2: Implement LocalGitBackend.pushStream

Replace the buffered `push()` with a streaming `pushStream()` built on `child_process.spawn`. This is the core of the ADR.

## Files to touch

- `electron/backend/local-git.ts`
  - Add `import { spawn } from "node:child_process"`.
  - Implement `pushStream(cwd, opts, callbacks): { cancel }`:
    - Build args: `["push"]` + (`opts.setUpstream` ? `["--set-upstream"]` : `[]`) + `[opts.remote ?? "origin"]` + `[branch]`. If `opts.branch` is undefined, resolve via `git rev-parse --abbrev-ref HEAD` synchronously *before* spawning push (use the existing `execGit` helper). If resolution fails, invoke `onDone({ exitCode: null, stderr: <error message> })` and return a no-op `cancel`.
    - Spawn:
      ```ts
      const child = spawn("git", args, {
        cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "/bin/true",
        },
      });
      ```
    - Buffer stderr (push writes progress to stderr, not stdout). Maintain a `pending` string; on each `data` chunk, append, split on `\n`, emit each complete line via `callbacks.onLine`, keep the trailing partial as the new `pending`. Also accumulate the full stderr into a `stderrFull` string for the `onDone` payload.
    - Drain on `close`: if `pending` is non-empty, emit it as a final `onLine`, then call `callbacks.onDone({ exitCode, stderr: stderrFull })`. Use `child.on("close", ...)` not `"exit"` so streams are flushed.
    - Handle `child.on("error", err)` (spawn failure): emit `onDone({ exitCode: null, stderr: err.message })`.
    - `cancel` returns a function that calls `child.kill("SIGTERM")` if the process is still alive. Idempotent (no-op if already exited).
  - Delete the old `push(cwd, remote?, branch?)` method.

- `electron/backend/__tests__/local-git-pushstream.test.ts` (new) — Vitest, mock `node:child_process`'s `spawn` with an `EventEmitter`-based fake child:
  - Test args composed correctly (with/without `setUpstream`, default remote, explicit branch).
  - Test env vars set: `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=/bin/true`.
  - Test line buffering: emit two chunks `"foo\nbar"` then `"\nbaz\n"` → expect `onLine` called with `"foo"`, `"bar"`, `"baz"`.
  - Test drain-before-done: emit `"partial"` (no newline) then `close` event → `onLine("partial")` fires before `onDone`.
  - Test cancel: call returned `cancel()` → expect `child.kill("SIGTERM")` invoked once. Calling `cancel` again after exit is a no-op.
  - Test spawn error: emit `error` event → `onDone({ exitCode: null, stderr: <error msg> })`.

- `electron/backend/types.ts` — Remove the old `push` method from `GitBackend` interface (since impl is being deleted). Verify no other files implement `GitBackend` (if there are mocks/stubs, update them).

- Search for any other call sites of `LocalGitBackend.push` or `backend.git.push` and note them — they will be migrated in ticket 3 (IPC layer). Don't touch the renderer or IPC files in this ticket; just prepare so ticket 3 has a clean slate.

## Notes

- Stderr-not-stdout: `git push` writes its progress lines to stderr. Don't bother piping/parsing stdout.
- Don't add a timeout — the ADR explicitly drops the hard timeout in favor of cancellation.
- Don't categorize the error here — that's the caller's job (ticket 5 wires `categorizePushError`).
- The `onLine` callback may receive empty strings if git emits blank lines; pass them through, don't filter.
- The cancel handle must be returned **synchronously** from `pushStream`, not via a promise — UI needs it immediately to wire the Cancel button.
