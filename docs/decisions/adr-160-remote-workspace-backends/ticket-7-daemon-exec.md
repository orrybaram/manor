---
title: Add exec and execStream control requests to the daemon
status: todo
priority: high
assignee: sonnet
blocked_by: [2]
---

# Add exec and execStream control requests to the daemon

For a remote host, `git`, `which`, and port scanning must run on the remote box. Give
the daemon a general execution surface that `RemoteBackend` (ticket 8) drives through
the injected `Exec` from ticket 2.

Add to `electron/terminal-host/types.ts`:

- `ControlRequest`: `{ type: "exec"; cmd: string; args: string[]; cwd?: string;
  timeout?: number; maxBuffer?: number }` and
  `{ type: "readFile"; path: string }`.
- `ControlResponse`: `{ type: "execResult"; stdout: string; stderr: string;
  exitCode: number | null }`, `{ type: "fileContents"; contents: string }`.
- `StreamCommand`: `{ type: "execStream"; execId: string; cmd: string; args: string[];
  cwd?: string }` and `{ type: "execCancel"; execId: string }`.
- `StreamEvent`: `{ type: "execStdout" | "execStderr"; execId: string; data: string }`
  and `{ type: "execExit"; execId: string; exitCode: number | null }`.

Implement the handlers in `electron/terminal-host/index.ts` (and a small
`electron/terminal-host/exec-runner.ts` holding the child-process bookkeeping and the
`execId → child` map so cancel works).

Constraints:
- Use `execFile`/`spawn` with an argv array. **Never** shell-interpolate; no `shell: true`.
- Default timeout 30000ms, matching `LocalGitBackend.execGit`.
- Cap `maxBuffer` and truncate oversized output rather than throwing an unhandled error.
- Kill any live `execStream` children when their stream socket disconnects, so a dropped
  ssh connection cannot leak processes.
- These requests sit behind the existing token `auth` check like every other control
  request — confirm the new cases are inside that gate, not before it.

Add tests covering: a successful exec, a non-zero exit, a timeout, stream chunking, mid-run
cancel, and child cleanup on socket close.

## Files to touch
- `electron/terminal-host/types.ts` — the new request/response/stream variants.
- `electron/terminal-host/exec-runner.ts` — new; child bookkeeping and cancellation.
- `electron/terminal-host/index.ts` — wire the handlers inside the auth gate.
- `electron/terminal-host/__tests__/exec-runner.test.ts` — new.
