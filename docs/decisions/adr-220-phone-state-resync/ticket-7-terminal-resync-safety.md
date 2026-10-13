---
title: Terminal resync must not revive dead sessions or steal winsize
status: done
priority: high
assignee: opus
blocked_by: [3]
---

# Terminal resync must not revive dead sessions or steal winsize

Follow-up from ticket 3. A resync re-calls `pty.create` on every mounted terminal, which has two problems:

1. **Dead sessions come back.** If a pane's session exited while the socket was down, its `pty.onExit` event was lost. The resync `create` then spawns a fresh shell in a pane that should have shown as exited or closed.
2. **Winsize stealing.** `create` also bids for winsize ownership. A phone that resyncs can take the winsize back from a desktop window that attached after it, which reflows the desktop terminal.

What to do:
- Read the host's `pty.create` handler (`electron/bridge/handlers/pty.ts`) and the daemon's attach and spawn logic.
- Give create a way to say **attach only**, e.g. an options arg `{ attachOnly: true }` or a separate `pty.attach`.
  - Whichever you pick, place it per ADR-180 D7: `pnpm build` fails on an `ElectronAPI` method that is not in `HANDLERS`, `nativeApi`, `LOCALLY_SERVED` or `SUBSCRIPTIONS`.
  - It returns the snapshot when the session is alive, and a distinct "gone" result when it is not. It never spawns.
  - It also skips the winsize bid, so a re-attach does not claim ownership.
- In the resync path in `useTerminalLifecycle.ts`, use attach-only. On "gone", run whatever the pane does when it receives `pty.onExit`.
- Add tests for the handler (attach to a live session returns a snapshot; attach to a dead one returns gone and spawns nothing; no winsize claim). Add a lifecycle-level test if practical.

## Files to touch
- `electron/bridge/handlers/pty.ts` and whatever daemon or attach code it calls
- `src/electron.d.ts` (API type)
- `src/hooks/useTerminalLifecycle.ts`
- tests
