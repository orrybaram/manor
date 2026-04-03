---
title: Play selected sound via afplay in notification handler
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Play selected sound via afplay in notification handler

Update the notification handler in `electron/main.ts` to always send silent notifications and play the selected sound separately using macOS `afplay`.

Also add an IPC handler `preferences:playSound` so the renderer can trigger a sound preview.

## Implementation

### `electron/main.ts`
In `maybeSendNotification()`:
- Always set `silent: true` on the Notification
- After `notification.show()`, check `preferencesManager.get("notificationSound")`
- If it's a string (not `false`), spawn `afplay /System/Library/Sounds/${soundName}.aiff` via `child_process.execFile`
- Fire and forget — no need to await or handle errors

Add IPC handler:
```typescript
ipcMain.handle("preferences:playSound", (_event, soundName: string) => {
  execFile("afplay", [`/System/Library/Sounds/${soundName}.aiff`]);
});
```

### `electron/preload.ts`
Add to the `preferences` section:
```typescript
playSound: (name: string) => ipcRenderer.invoke("preferences:playSound", name),
```

### `src/electron.d.ts`
Add to the `preferences` interface:
```typescript
playSound: (name: string) => Promise<void>;
```

## Files to touch
- `electron/main.ts` — Update notification sound playback + add IPC handler
- `electron/preload.ts` — Expose playSound IPC
- `src/electron.d.ts` — Add playSound to type definition
