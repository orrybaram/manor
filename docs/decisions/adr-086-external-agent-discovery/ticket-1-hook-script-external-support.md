---
title: Allow hook script to fire for external sessions
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Allow hook script to fire for external sessions

The hook script at `~/.manor/hooks/notify.sh` currently bails when `MANOR_PANE_ID` is unset. Modify it to send events for external sessions using a synthetic identifier.

## Changes

When `MANOR_PANE_ID` is empty:
1. Extract the PID from the hook event JSON (`"pid"` field) or fall back to `$$` (shell PID, which is the agent's PID since hooks run as children)
2. Use `PPID` as the PID identifier (the hook runs as a child of the agent process, so `PPID` is the agent's PID)
3. Set `paneId` to `external:{PID}`
4. Set `KIND` to `${MANOR_AGENT_KIND:-claude}` (same as now)
5. Do NOT exit early — continue to the curl call

The hook server already accepts any string for `paneId`, so this requires no server-side URL changes.

## Files to touch
- `electron/agent-hooks.ts` — Update the `HOOK_SCRIPT` template string:
  - Remove the `[ -z "$MANOR_PANE_ID" ] && exit 0` guard
  - When `MANOR_PANE_ID` is empty, derive a synthetic pane ID: `PANE_ID="${MANOR_PANE_ID:-external:$PPID}"`
  - Use `$PANE_ID` in the curl args instead of `$MANOR_PANE_ID`
