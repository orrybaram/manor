---
title: Disconnected state, reconnect and resume after remote restart
status: todo
priority: high
assignee: sonnet
blocked_by: [3]
---

# Disconnected state, reconnect and resume after remote restart

Make "host unreachable for hours" a first-class state (ADR-178 §6).

1. **Disconnected UI:** when `BackendRegistry.list()` reports a host as not connected,
   its projects show a "Disconnected — reconnecting" badge in the sidebar; its panes
   keep the last rendered content, are read-only (input ignored), and show a slim
   banner with a "Retry now" `Button`. No error toasts for routine disconnects.
   Reuse ADR-169's reconnect backoff (read `docs/decisions/` ADR-169 and
   `electron/terminal-host/client.ts` reconnect logic) per host.
2. **On reconnect:** reattach panes via existing snapshot/attach, run hook replay
   (ticket 3 already does this in the registry — just make sure pane reattach happens
   after replay so agent dots are correct on first paint), recreate port forwards
   (ticket 6 hook point — leave a TODO-free no-op if ticket 6 is not merged yet).
3. **Remote restart:** compare the renderer's expected remote panes against the
   daemon's `listSessions`. For each missing pane, run the existing resume-on-relaunch
   path (ADR-144; find it via `get_resume_command` / `agents:buildResumeCommand`): new
   shell in the same cwd, and if the pane had an `agentSessionId`, type the connector's
   resume command. Show a one-time notice "Remote host restarted — N sessions resumed".

## Files to touch
- `electron/backend/registry.ts` — per-host reconnect, reconnect sequencing.
- `src/store/app-store.ts` — per-host connection state, missing-pane resume trigger.
- `src/components/` — sidebar badge, pane banner (use `Button` / `Tooltip`).
- `src/terminal/` — read-only mode while disconnected.
