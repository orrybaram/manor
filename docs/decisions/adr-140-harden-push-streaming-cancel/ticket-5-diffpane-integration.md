---
title: Wire DiffPane to streaming push and toast lifecycle
status: done
priority: critical
assignee: opus
blocked_by: [3, 4]
---

# Ticket 5: DiffPane integration with toast and recovery actions

Replace the inline-error push handler in DiffPane with the streaming flow: start → progress events drive a toast → toast handles cancel + categorized recovery actions.

## Files to touch

- `src/components/workspace-panes/DiffPane/DiffPane.tsx`
  - **Remove** all inline error state: `pushError`, `setPushError`, the inline `<div>` rendering it, and the IPC error-message string-cleaning regex. The toast is now the only error surface.
  - Keep `pushing` state OR derive it from toast presence — pick whichever produces simpler code (likely keep local `pushing` to disable the button without subscribing to the toast store from DiffPane).
  - Rewrite `handlePush` (and add a small helper `runPush`) so:
    1. Add a top-level `useEffect` in DiffPane (or extract to a `usePushSubscription(workspacePath)` hook in `src/hooks/`) that subscribes to `window.electronAPI.git.push.onProgress` on mount and unsubscribes on unmount. Filter events by `pushId === workspacePath`.
    2. `runPush(opts: { setUpstream?: boolean } = {})`:
       - `setPushing(true)`.
       - Call `addToast({ id: pushId, status: "loading", message: "Pushing… 0s", persistent: true, action: { label: "Cancel", onClick: () => electronAPI.git.push.cancel(pushId) } })`.
       - Start an interval that ticks the elapsed counter and calls `updateToast(pushId, { message: \`Pushing… ${elapsed}s\` })`. Store the interval id in a ref so it can be cleared.
       - `await electronAPI.git.push.start({ wsPath: workspacePath, setUpstream: opts.setUpstream })`. If start itself rejects (e.g. "already in progress"), surface as an error toast and clear the interval.
    3. In the `onProgress` handler:
       - On `type: "line"`: `updateToast(pushId, { detail: line })` — only the latest line is kept; the full log is reconstructed in the done branch via the `stderr` payload.
       - On `type: "done"`:
         - Clear the elapsed interval; `setPushing(false)`.
         - If `exitCode === 0`: `updateToast(pushId, { status: "success", message: "Pushed", persistent: false, action: undefined, detail: undefined, duration: 3000 })`. (Branch/remote in the message would be nice but is best-effort — derive from a quick `git rev-parse` only if cheap; otherwise just "Pushed".)
         - If `exitCode !== 0` and stderr matches "cancelled" semantics (SIGTERM exit code is null on macOS or the default `143`), update toast to `status: "error"` with `message: "Push cancelled"`, `persistent: false`, `duration: 3000`, no detail. Detect cancel by checking whether the cancel handler was invoked (track via ref or a `cancelled` flag set in the `onClick` Cancel callback) — don't try to infer cancel from exit code alone, it's brittle.
         - Otherwise: call `categorizePushError(stderr)` (imported from `electron/backend/push-error` — verify this is importable from the renderer; if not, re-export through preload or duplicate the module under `src/lib/push-error.ts` keeping it in lockstep with the electron copy via a comment). Build the toast update:
           ```ts
           updateToast(pushId, {
             status: "error",
             message: error.message,
             detail: stderr.trim(),
             persistent: true,
             autoExpand: true,
             action: error.action ? buildActionFor(error.action) : undefined,
           });
           ```
           Where `buildActionFor`:
           - `set-upstream` → `{ label: "Push with --set-upstream", onClick: () => runPush({ setUpstream: true }) }`.
           - `pull-and-retry` → `{ label: "Pull & retry", onClick: () => pullThenPush() }`. If a pull IPC method exists, use it; otherwise the action label points to the terminal: `{ label: "Open terminal", onClick: () => openTerminalForWorkspace(workspacePath) }`. Search for an existing pull method on `electronAPI.git`; if absent, fall back to the terminal action and note it in the ticket completion.

- `src/types/electron.d.ts` (or wherever the renderer-facing electron API type lives) — Update if not already done in ticket 3.

- `src/components/ui/Toast/ToastItem.tsx` — Verify the new `autoExpand` field added in ticket 4 propagates through `useToastStore.updateToast`. If `updateToast` strips unknown fields, this needs adjustment in the store (ticket 4 should have handled it; double-check).

## Notes

- The categorizer module currently lives under `electron/`. Renderer code generally cannot import from `electron/` (different tsconfig include paths). Check `tsconfig.json` and `vite.config.ts` for path aliases. If renderer can't import `electron/backend/push-error.ts` cleanly, the cleanest fix is to **move** the module to a shared location (e.g. `src/lib/push-error.ts` or `shared/push-error.ts`) and have the electron side import from there. Update ticket 1's tests accordingly. Do this in this ticket, not via a follow-up ADR.
- Cancel detection via a ref-tracked `cancelledRef.current = true` (set inside the Cancel `onClick`) is more reliable than parsing exit codes. Reset between pushes.
- Don't show a toast for the brief moment between `await start` resolving and the first progress event — the loading toast is added BEFORE awaiting `start`, so the user sees it immediately.
- Elapsed counter ticks every 1s; use a `setInterval` not `requestAnimationFrame` (no need for 60fps).
- The push button stays disabled while `pushing` is true; no other state needed.
