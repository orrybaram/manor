---
title: Add catch-all error response in daemon handler
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add catch-all error response in daemon handler

Ensure the daemon always sends a response to the client, even if `handleControlMessage` throws an unexpected error. This keeps the client's FIFO response queue in sync.

## Files to touch
- `electron/terminal-host/index.ts` — in `createSerializedHandler`, wrap the handler call so that if it rejects/throws, an error response is sent to the socket before logging. This requires passing the socket reference into the serialized handler wrapper.
