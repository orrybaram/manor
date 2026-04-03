---
title: Disconnect client on request timeout
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Disconnect client on request timeout

When a control request times out, disconnect the client (call `cleanup()`) to prevent stale responses from corrupting the FIFO response queue. The next operation will reconnect automatically via `ensureConnected()`.

## Files to touch
- `electron/terminal-host/client.ts` — in the `request()` method's timeout handler, call `this.cleanup()` after rejecting the pending request. Also improve the error message in `doCreateOrAttach` to include the actual response type for debugging (change `"unknown"` to include `createResp.type`).
