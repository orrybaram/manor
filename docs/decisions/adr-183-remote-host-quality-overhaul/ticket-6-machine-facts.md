---
title: MachineFacts per host; rename Local* backends
status: in-progress
priority: high
assignee: opus
blocked_by: [5]
---

# MachineFacts per host; rename Local* backends

Read `index.md`. Model local as just another host.

1. **One `MachineFacts` interface.** Add `electron/backend/machine-facts.ts`
   with:
   - `platform(): Promise<"darwin" | "linux" | string>`
   - `uid()`
   - `homeDir()` (validated absolute)
   - `kill(pid, signal)`
   - `exists(p)`
   - `readFile(p)`
   - `join(...parts)`
   - `defaultWorktreeRoot(projectName)`

   `localFacts()` uses `fs`, `os` and `path`. `execFacts(exec)` uses the
   remote exec: `test -e`, `cat`, a POSIX join, `printf %s "$HOME"`, `uname`,
   `id -u`. Both share a `memoRetry` helper, the `??= … .catch` retry-memo
   that is currently written four times.

   It replaces `ShellHost`/`localShellHost`/`execShellHost` in `local-shell.ts`
   and `PortsHost`/`localPortsHost`/`execPortsHost` in `local-ports.ts`. Those
   currently read `homeDir` two different ways, one of them without
   validation.
2. **Hang `facts` off `WorkspaceBackend`** (`backend.facts`) so every host
   exposes it. `ShellBackend.homeDir` then delegates to it, or goes away if it
   is redundant.
3. **Rename the backends to what they are:**

   | Old | New |
   |---|---|
   | `LocalPtyBackend` | `DaemonPtyBackend` |
   | `LocalGitBackend` | `ExecGitBackend` |
   | `LocalShellBackend` | `ExecShellBackend` |
   | `LocalPortsBackend` | `ExecPortsBackend` |

   Rename the files too, keeping git history via `git mv`.
4. **One host-backend factory.** `LocalBackend` and `RemoteBackend` both build
   the same four classes. Add one `createHostBackend(client, exec, facts)`.
   - `LocalBackend` becomes a call to it.
   - `RemoteBackend` keeps only what is really remote: reconnect policy and
     bootstrap wiring. If ticket 5's `HostConnection` already owns those, fold
     `RemoteBackend` into it.

5. **Ticket 5 follow-ups.**
   - Pass the version once, in each backend's constructor. Make `RemoteBackendOptions.version` required, and remove `WorkspaceBackend.connect(opts?: { version })`'s version option.
   - Delete `RoutedBackend.onHostEvent`, which has no production caller.
   - Make `HookReplay.epoch`/`HookCursor.epoch` non-optional where every journal now has one, and simplify `isReset` accordingly. Keep tolerating a persisted cursor with a null epoch by treating it as "reset once".

Run `npx tsc --noEmit -p` over all three tsconfigs (baseline 0/0/8), `pnpm build`, and the `electron/backend` tests.

## Files to touch
- `electron/backend/machine-facts.ts` (new)
- `electron/backend/local-shell.ts`, `local-ports.ts`, `local-git.ts`, `local-pty.ts` (renamed)
- `electron/backend/local-backend.ts`, `remote-backend.ts`, `types.ts`, `exec.ts`, `remote-exec.ts`
- import sites across `electron/` and the related tests
