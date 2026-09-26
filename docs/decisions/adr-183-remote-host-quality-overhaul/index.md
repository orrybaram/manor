---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-183: Remote-host code-quality overhaul

## Context

ADR-160, ADR-178 and ADR-179 added remote hosts. The branch that carries them
(`feat/adr-160-178-remote-projects`) got a strict code-quality review against
`main`: 54 commits and about 28k lines. Everything works. But the same
structural mistakes show up in every layer, and the review turned up real bugs
on the way. This ADR collects the fixes so the branch can merge in good shape.

**Bugs found.**
- `BranchWatcher` has no guard against a stale tick, so an old scan can write
  into a restarted watcher.
- `pendingTypedTexts` is never cleared when a pane or tab closes, and it drops
  its text when the host is away.
- A `~` worktree root is expanded when it is saved, so it is lost when the
  project moves to another host.
- Clone progress and worktree progress share one channel and interfere with
  each other. The `SetupStep` type has no `"clone"` value.
- `~/.claude.json`, `settings.json` and the Codex config are written
  non-atomically.
- Unsubscribe handles from `onEvent` are discarded.
- The client routes a reply that has no `requestId` to the oldest pending
  request.
- Clone dialogs show Electron's "Error invoking remote method…" prefix.

**Structural problems.**
- **Local vs remote is decided again and again.** `hostForPath` is threaded
  into four constructors. `persistence.ts` compares against `LOCAL_HOST_ID` in
  about ten places. Host is inferred by prefix-matching paths even though the
  renderer already knows each workspace's `hostId`.
- **Backend calls pass through too many layers.** A call goes `RoutedBackend` →
  gated Proxy view → `RemoteBackend` → `Local*Backend` → remote exec → client.
  `registry.ts` has 1001 lines and five jobs, and it repeats a
  "this entry is still current" identity check 11 times. Two rules conflict on
  which host owns a session.
- **The daemon keeps asking which role it has.** `namespace` is a mutable global
  with `=== "remote"` checks. Bootstrap runs twice. Capabilities are detected by
  sniffing "unknown request type" strings. Client and daemon each keep their own
  list of env keys to filter.
- **The same logic exists in several drifting copies.** There are three per-host
  pollers, two clone dialogs, a second pending-command queue, six or more
  `errorMessage` helpers, and four versions of the "cancel handle over an async
  precondition" stream.
- **Dead surface.**
  - The keep-awake and provider scaffolding (`host-busy.ts`, `setBusy`,
    `status`, `ensureUp`, `autoSleep`, `persistsMemory`, `previewUrl`).
  - `hostId` in `ProjectUpdatableFields`.
  - Unused `host-store` actions and `hosts:remove`.
  - `backendType`.
  - The bridge's `daemonVersion` and `--stream`.
  - `hookPort` in the `bootstrap` reply.
- **Files over 1k lines.**

  | File | Lines before → after this branch |
  |---|---|
  | `persistence.ts` | 1398 → 2253 |
  | `client.ts` | 837 → 1292 |
  | `registry.ts` | new, 1001 |
  | `webview-server.ts` | 977 → 1015 |

## Decision

Restructure behind the current behaviour, in this order: bugs, dead code,
duplicates, then architecture. The target model:

1. **Host travels with the path.** Main-process consumers such as the watchers,
   the port scanner and prewarm receive `{ path, hostId }` entries instead of
   bare paths plus a `hostForPath` resolver. Prefix matching is kept only where
   a bare path genuinely comes in from outside (e.g. a pty `cwd` with no pane
   history), and it lives in one place.
2. **Local is just another host.** A `MachineFacts` interface covers `platform`,
   `uid`, `homeDir`, `kill`, `exists`, `readFile`, `join` and
   `defaultWorktreeRoot`. It has a local implementation (`fs`/`os`) and an exec
   implementation, and it replaces `ShellHost`/`PortsHost` and the local/remote
   branches in `persistence.ts`. `Local*Backend` classes are renamed to what
   they are (`DaemonPtyBackend`, `ExecGitBackend`, …).
3. **Per-host state is an object.** `registry.ts` splits into:
   - `HostConnection`: status, tokens and `disposed`, which replaces the
     identity checks.
   - `host-view.ts`: the gates and the unavailable backend.
   - `SessionOwners`: one explicit `claim` rule.
   - a small `Emitter<T>`.

   The version is passed once, to the constructor.
4. **The daemon knows its role.** A `DaemonRole` (`localRole`/`remoteRole`) is
   built once in `main()`. It owns the paths, the startup bootstrap (run once and
   cached), the env-key filter and the hook journal. The protocol gets typed
   request/response maps and an envelope that always carries `requestId`, and
   string-sniffing capability checks go away.
5. **One copy of everything.**
   - `PerHostPoller<T>`.
   - `useHostCloneFlow` with shared step views.
   - `pendingPaneCommands: { text, submit }`.
   - `ipcErrorMessage` for the renderer, one `errorMessage` for main.
   - `streamAfter` and `gitProgressStream`.
   - `writeFileAtomic`.
6. **Files over 1000 lines are split** into modules with one job each:
   - `electron/projects/*`
   - `terminal-host/{reconnect-supervisor,rpc-channel,exec-stream-registry}.ts`
   - `electron/routes/webview.ts`
7. **Dead surface is deleted.** It can be re-added with the first managed
   provider when that needs it.

## Consequences

**Gains.**
- Far fewer concepts to keep in mind.
- Local/remote branching disappears rather than moving somewhere else.
- The bugs above are fixed as a side effect of merging the duplicate copies.
- Each over-large file drops below 1k lines.

**Risks.**
- Wide churn on a feature branch that is still being tested by hand. Mitigation:
  the tickets run one after another, each builds and passes its tests before the
  next starts, and the full suite plus the remote e2e run at the end.
- The protocol changes (typed envelope, `requestId` always echoed, capability
  sniffing removed) need the client and daemon at the same version. The version
  handshake already forces that, and remote installs are pinned by version. Dev
  boxes need a daemon reinstall after this ADR.
- Deleting the keep-awake scaffolding means ADR-178's managed-provider plan has
  to add it back later. That is intentional: unused abstractions cost more than
  re-adding them.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
