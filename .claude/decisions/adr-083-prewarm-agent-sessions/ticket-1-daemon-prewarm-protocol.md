---
title: Add prewarm and claim protocol to daemon
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add prewarm and claim protocol to daemon

Add two new request types to the terminal host daemon's control protocol and implement them in the `TerminalHost` class.

## New request types

### `prewarm`
```typescript
{ type: "prewarm", sessionId: string, cwd: string, cols: number, rows: number }
```
- Creates a new `Session` (same as `create`) and calls `spawn()`
- Marks the session internally as `prewarmed: true` so it's excluded from `listSessions` responses (UI shouldn't see it)
- Returns `{ type: "prewarmed", session: SessionInfo }`

### `claimPrewarmed`
```typescript
{ type: "claimPrewarmed", oldSessionId: string, newSessionId: string, cwd?: string, cols?: number, rows?: number }
```
- Finds the session by `oldSessionId`, removes it from the sessions map
- Re-inserts it under `newSessionId` (updates the session's internal `sessionId`)
- If `cwd` differs from the session's current CWD, writes `cd <cwd>\n` to the PTY
- If `cols`/`rows` differ, resizes the PTY
- Clears the `prewarmed` flag
- Returns `{ type: "claimed", session: SessionInfo, snapshot: TerminalSnapshot }`
- Returns error if session not found or not prewarmed

## Files to touch
- `electron/terminal-host/terminal-host.ts` — Add handlers for `prewarm` and `claimPrewarmed` request types, add `prewarmed` flag tracking
- `electron/terminal-host/session.ts` — Add `sessionId` setter or rename method, add `prewarmed` flag
- `electron/terminal-host/types.ts` — Add new request/response types to the protocol type definitions
- `electron/terminal-host/client.ts` — Add `prewarm()` and `claimPrewarmed()` methods to `TerminalHostClient`
