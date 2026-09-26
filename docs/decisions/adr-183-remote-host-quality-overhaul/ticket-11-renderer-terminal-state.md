---
title: Renderer — one pending-command queue, delivered writes, remote pane store
status: in-progress
priority: medium
assignee: opus
blocked_by: [10]
---

# Renderer — one pending-command queue, delivered writes, remote pane store

Read `index.md`.

1. **One pending-command queue.**
   - `pendingTypedTexts` duplicates `pendingPaneCommands`. Replace both with
     `pendingPaneCommands: Record<string, { text: string; submit: boolean }>`.
   - `addTerminalTab(command, { submit })` replaces `addTerminalTabWithTypedText`.
   - Delete `setPendingTypedText` (it is never called) and
     `consumePendingTypedText`.
   - In `useTerminalLifecycle.ts`, one `sendOnShellReady(text, { submit })`
     replaces `typeOnShellReady`.
   - This fixes two bugs: typed text is now cleared on closeTab and closePane,
     and it now respects "host away". Add store tests for both.
2. **`write` reports delivery.**
   - `useTerminalConnection`'s `write` returns whether the data was delivered.
   - `send` sets `sent` from that return value.
   - Delete `hostAway()` and the duplicated `isPaneInputBlocked` store reads in
     `useTerminalLifecycle`.
   - Move the unsent-pane-command requeue next to `write`.
3. **Typed `pty.create` result.** Export a discriminated union from
   `electron.d.ts`:
   `{ ok: true; hostId; snapshot; … } | { ok: false; reason: "host-unavailable"; hostId; error } | { ok: false; reason: "error"; error }`.
   Main returns it from `ipc/pty.ts`. Use it in `useTerminalConnection` and
   `useTerminalLifecycle`, deleting the inline re-declaration.
4. **One remote-pane store.**
   - Merge `pane-host-store` and `pane-reattach-store` into
     `src/store/remote-pane-store.ts`, keyed by pane:
     `{ hostId, awaiting, reattachEpoch, reattachPending }`.
   - Give it a single `forgetPane`. Today `forgetPane` misses the reattach
     state.
   - Move the module-level `awaitingHostByPane` Map and `pendingReattach` Set
     into the store.
   - In `useRemoteRecovery`, compute the window's pane-id set once per event,
     not once per pane.

Run `pnpm build`, lint and the store/hook tests.

## Files to touch
- `src/store/app-store.ts`, `src/hooks/useTerminalLifecycle.ts`, `src/hooks/useTerminalConnection.ts`
- `src/store/pane-host-store.ts`, `src/store/pane-reattach-store.ts` → `src/store/remote-pane-store.ts`
- `src/hooks/useRemoteRecovery.ts`, `src/lib/remote-recovery.ts`, `src/components/sidebar/AddProjectDialog/*` and other callers of `addTerminalTabWithTypedText`
- `src/electron.d.ts`, `electron/ipc/pty.ts`
- related tests
