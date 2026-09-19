---
title: Follower mode — a web viewer never resizes a pane the desktop owns
status: todo
priority: high
assignee: opus
blocked_by: [3, 4]
---

# Follower mode — a web viewer never resizes a pane the desktop owns

ADR-178 D5. One winsize owner per session. Slice 1 places the check in main,
which already sees every desktop `pty:create`, `pty:close` and `pty:detach`.

## Main

- `electron/pty-attachments.ts` (new) — `desktopAttached: Set<paneId>`;
  `attach(paneId)`, `release(paneId)`, `isDesktopAttached(paneId)`. Called from
  the desktop path only: `electron/ipc/pty.ts`'s `pty:create` (attach on
  success), `pty:close` and `pty:detach` (release). A desktop window that dies
  releases every pane it held — hook the existing window-closed path in
  `electron/window.ts` / `app-lifecycle.ts` where renderer windows are
  forgotten.
- `electron/remote-control/ws-handlers.ts` — `pty.create` for a web viewer:
  call the lifted create function, then decorate the result with
  `winsizeOwner: !isDesktopAttached(paneId)` and the session's current
  `cols`/`rows` (from `backend.pty.getSnapshot` or the `SessionInfo` the
  create returns — check `terminal-host/types.ts`). `pty.resize` for a web
  viewer: if `isDesktopAttached(paneId)`, resolve **without** calling the
  backend (a follower asking is not an error; refusing loudly would make
  `useTerminalResize` log on every layout tick).

## Renderer

- `src/electron.d.ts` — `pty.create`'s result gains optional
  `winsizeOwner?: boolean; cols?: number; rows?: number`. The preload path
  never sets them; absent means owner.
- `src/hooks/useTerminalConnection.ts` (or wherever `create` is wrapped —
  read `useTerminalLifecycle.ts:74`) — surface `follower` and the owner's
  `{cols, rows}` from the create result.
- `src/hooks/useTerminalResize.ts` — a fifth argument
  `follower: { cols: number; rows: number } | null`. When non-null: do not
  call `sendFit`; instead `fitFollower()` — measure the cell width xterm is
  actually using (the `.xterm-char-measure-element` inside `term.element`, or
  `term._core._renderService.dimensions.css.cell.width` if the public
  measure element is unreliable — prefer the DOM element), compute
  `fontSize = floor(current * available / (cols * cellWidth))`, clamp to
  `[6, 12]` (ADR-177's `FONT_FLOOR`/`FONT_CEILING`; on a PC the ceiling wins
  and nothing changes), set `term.options.fontSize`, then
  `term.resize(cols, rows)`. Re-run on `ResizeObserver` ticks. The container
  gets `overflow-x: auto` in follower mode so a grid wider than the floor
  allows scrolls sideways rather than wrapping.
- `useTerminalStream` already applies incoming `resized` events to the
  emulator (ADR-164); confirm that path runs for a follower and that a
  follower's `term.resize` from the stream does not trigger `sendFit` through
  `term.onResize` (it will — guard with the `follower` flag).
- `src/components/workspace-panes/` terminal pane — a small
  "following desktop · 160×45" affordance in the pane's status line when
  `follower` is set, so the user knows why fit is off.

## Tests

- `electron/__tests__/pty-attachments.test.ts` — attach/release/window-death.
- `src/hooks/__tests__/useTerminalResize.test.ts` — with `follower` set,
  `resizePty` is never called and `term.options.fontSize` lands within the
  clamp for a narrow container; with `null`, behaviour is unchanged
  (`shouldSendFit` tests stay green).

## Files to touch
- `electron/pty-attachments.ts` — new
- `electron/ipc/pty.ts` — attach/release calls on the desktop path
- `electron/window.ts` / `electron/app-lifecycle.ts` — release on window death
- `electron/remote-control/ws-handlers.ts` — decorate `pty.create`, gate `pty.resize`
- `src/electron.d.ts` — create result fields
- `src/hooks/useTerminalConnection.ts`, `useTerminalLifecycle.ts` — thread `follower`
- `src/hooks/useTerminalResize.ts` — follower fit
- `src/hooks/useTerminalStream.ts` — guard the `onResize` → `sendFit` loop
- terminal pane component under `src/components/workspace-panes/` — affordance
