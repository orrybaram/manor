---
title: UI for adding and monitoring remote hosts
status: todo
priority: medium
assignee: sonnet
blocked_by: [9]
---

# UI for adding and monitoring remote hosts

Give the user a way to attach a project to a remote host and to see what the connection
is doing. Without this the feature is unreachable.

1. **Add a host** — in the project add/edit flow, allow choosing `local` (default) or
   entering an ssh target (`user@host`, `host`, or an ssh config alias). Validate
   non-empty and reject characters outside the shell-safe allowlist used in ticket 5.
2. **Connection status** — show per-host state (connecting / installing host / connected /
   reconnecting / error) sourced from `BackendRegistry.list()`. Bootstrap installs take
   tens of seconds on a cold box, so show the progress text from ticket 6 rather than an
   indefinite spinner.
3. **Errors** — the four failure modes need distinguishable messages: ssh auth failure
   (with the `ssh-add` hint), unsupported platform / missing Node, host binary install
   failure, and connection dropped. Do not collapse them into "connection failed".
4. **Hook-forward warning** — surface the ticket 10 diagnostic as a non-blocking warning
   on the host: agents will run but status will not update.
5. **Pane affordance** — a remote pane should be visually identifiable (host name on the
   tab or pane header). Follow the existing patterns in `src/lib/tab-styles.ts`.

Per `.claude/rules/ui-components.md`, use `Button` from `src/components/ui/Button/Button`
and `Tooltip` from `src/components/ui/Tooltip/Tooltip` — no raw `<button>`. Check
`src/components/ui/` for an existing input/select before adding one.

## Files to touch
- `src/components/` — project add/edit form: host selection field.
- `src/components/` — host status surface (reuse the existing sidebar/status patterns
  rather than inventing a new panel).
- `src/lib/tab-styles.ts` — remote pane affordance.
- `electron/preload.ts` + `electron/ipc/` — IPC for registering a host and reading
  `BackendRegistry.list()`.
