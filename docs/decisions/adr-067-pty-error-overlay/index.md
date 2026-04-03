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

# ADR-067: Show error overlay when PTY creation fails (shell permissions)

## Context

When macOS denies zsh/shell permissions (Privacy & Security), Manor fails silently. The PTY spawn either throws (caught as MSG.ERROR in `pty-subprocess.ts`) or the process exits immediately. In both cases:

1. The `pty:create` IPC handler returns `{ ok: false, error: "..." }` but `useTerminalLifecycle.ts` ignores the error — it only acts on `result.ok === true`.
2. The daemon broadcasts `pty-error-${paneId}` events, but the preload doesn't expose an `onError` listener, and the renderer never subscribes.

The user sees an empty black terminal pane with no feedback.

## Decision

Add an error overlay to the TerminalPane component that shows when PTY creation fails or when a runtime error is received. The changes are:

1. **Preload** (`electron/preload.ts`): Add `onError` to the `pty` API object, mirroring `onOutput`/`onExit`/`onCwd`.

2. **Type definitions** (`src/vite-env.d.ts`): Add `onError` to the `electronAPI.pty` type.

3. **useTerminalStream** (`src/hooks/useTerminalStream.ts`): Subscribe to the new `onError` channel and call a callback to surface the error.

4. **useTerminalLifecycle** (`src/hooks/useTerminalLifecycle.ts`): When `create()` returns `{ ok: false, error }`, set an error state. Also accept errors from the stream.

5. **TerminalPane** (`src/components/TerminalPane.tsx`): Render an error overlay when error state is set. The overlay shows the error message and a hint about macOS shell permissions with a button to open System Preferences.

6. **TerminalPane.module.css**: Styles for the error overlay.

## Consequences

- First-time users who haven't granted shell permissions will see a clear, actionable error message.
- Runtime PTY errors (crash, permission revoked mid-session) are also surfaced.
- No changes to the daemon or main process — the error channels already exist, they just weren't wired to the UI.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
