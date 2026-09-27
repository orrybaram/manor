---
title: Replace daemon only on protocol mismatch
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Replace daemon only on protocol mismatch

Read ADR-185 `index.md` §B first.

1. In `electron/terminal-host/pty-subprocess-ipc.ts` add
   `export const PTY_SUBPROCESS_PROTOCOL = 1;` with a doc comment (same style as
   `TERMINAL_HOST_PROTOCOL` in `types.ts`): what it versions (the frame types +
   payload shapes in this file), when to bump it, and why it exists (an old
   daemon forks the *new* bundle's `pty-subprocess.js` after an update — ADR-185).
2. In `electron/terminal-host/types.ts`, add optional `ptyProtocol?: number` to the
   handshake `ControlResponse` variant. Add `daemonPtyProtocolOf(response)`
   mirroring `daemonProtocolOf` (0 when absent).
3. In `electron/terminal-host/index.ts` handshake handler, reply with
   `ptyProtocol: PTY_SUBPROCESS_PROTOCOL`. Update the nearby comment ("Version
   mismatch causes the client to kill and respawn the daemon") to describe the
   protocol rule.
4. Rewrite `isDaemonStale(response, clientVersion)` in `types.ts`: stale iff the
   response is not a handshake, or `daemonProtocolOf(response) !== TERMINAL_HOST_PROTOCOL`,
   or `daemonPtyProtocolOf(response) !== PTY_SUBPROCESS_PROTOCOL`. App version is
   no longer a reason. Keep the `clientVersion` parameter only if still used
   (e.g. for a log line); otherwise drop it and update the call site in
   `client.ts`. Rewrite its doc comment and the `TERMINAL_HOST_PROTOCOL` doc
   paragraph that says the daemon "is only replaced when the *app version*
   differs" so they describe the new rule and cite ADR-185.
5. Update `isDaemonStale` tests in `electron/terminal-host/client.test.ts`:
   - different daemonVersion + same protocols → NOT stale
   - older protocol → stale; newer protocol → stale
   - missing ptyProtocol → stale; mismatched ptyProtocol → stale
   - fully matching → not stale
   Fix any other tests that relied on version-mismatch restarts (grep `daemonVersion`
   in `electron/terminal-host/*.test.ts` and `electron/backend/**/*.test.ts`).
6. Check `electron/terminal-host/transport-ssh.ts` / `electron/backend/remote-bootstrap.ts`
   comments that claim a version mismatch restarts the remote daemon; update
   wording if they're now wrong (behaviour change not needed there).

Run `pnpm vitest run electron/terminal-host` and the typecheck used on this repo
(`pnpm typecheck` or `tsc -p tsconfig.electron.json --noEmit` — check package.json).

## Files to touch
- `electron/terminal-host/pty-subprocess-ipc.ts` — new constant
- `electron/terminal-host/types.ts` — handshake type, helper, `isDaemonStale`, docs
- `electron/terminal-host/index.ts` — reply with `ptyProtocol`
- `electron/terminal-host/client.ts` — call site if signature changes
- `electron/terminal-host/client.test.ts` — staleness tests
