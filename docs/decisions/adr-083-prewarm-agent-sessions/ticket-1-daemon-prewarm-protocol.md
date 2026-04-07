---
title: Add prewarmed flag and createNoSubscribe to client
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add prewarmed flag and createNoSubscribe to client

Two small changes to support pre-warming without new daemon protocol types.

## 1. Session prewarmed flag

Add a mutable `prewarmed` boolean to `Session` so prewarmed sessions can be excluded from `listSessions()`.

In `electron/terminal-host/session.ts`:
- Add `prewarmed = false` property to `Session`

In `electron/terminal-host/terminal-host.ts`:
- Add optional `prewarmed` param to `create()`: `create(sessionId, cwd, cols, rows, shellArgs, prewarmed?)`
- After creating the Session, set `session.prewarmed = prewarmed ?? false`
- In `listSessions()`, filter out sessions where `prewarmed === true`

In `electron/terminal-host/types.ts`:
- Add `prewarmed?: boolean` to the `create` ControlRequest variant
- Add `prewarmed?: boolean` to `SessionInfo`

In `electron/terminal-host/index.ts` (daemon):
- Pass `request.prewarmed` through to `host.create()` in the `case "create"` handler

## 2. Client createNoSubscribe method

In `electron/terminal-host/client.ts`, add:

```typescript
async createNoSubscribe(
  sessionId: string,
  cwd: string,
  cols: number,
  rows: number,
  prewarmed = false,
): Promise<SessionInfo> {
  await this.ensureConnected();
  const resp = await this.request({
    type: "create",
    sessionId,
    cwd,
    cols,
    rows,
    prewarmed,
  });
  if (resp.type !== "created") {
    throw new Error(
      `Create failed: ${resp.type === "error" ? resp.message : resp.type}`
    );
  }
  return resp.session;
}
```

This sends the existing `create` control request but does NOT call `streamWrite({ type: "subscribe" })`. The session boots silently — no output events flow to the renderer.

## 3. Clear prewarmed flag on warm-restore

When `createOrAttach` finds an existing session via `getSnapshot`, the session is being claimed. The prewarmed flag should be cleared so it appears in future `listSessions` calls.

In `electron/terminal-host/terminal-host.ts`, add a method:
```typescript
clearPrewarmed(sessionId: string): void {
  const session = this.sessions.get(sessionId);
  if (session) session.prewarmed = false;
}
```

In `electron/terminal-host/index.ts`, in the `case "getSnapshot"` handler, after finding the snapshot, call `host.clearPrewarmed(request.sessionId)`. This is safe because `getSnapshot` is only called during warm-restore (in `createOrAttach`).

## Files to touch
- `electron/terminal-host/session.ts` — Add `prewarmed` property
- `electron/terminal-host/terminal-host.ts` — Add `prewarmed` param to `create()`, filter `listSessions()`, add `clearPrewarmed()`
- `electron/terminal-host/types.ts` — Add `prewarmed` to create request and SessionInfo
- `electron/terminal-host/index.ts` — Pass `prewarmed` in create handler, call `clearPrewarmed` in getSnapshot handler
- `electron/terminal-host/client.ts` — Add `createNoSubscribe()` method
