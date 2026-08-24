---
title: Renderer notification store and shared navigation helper
status: todo
priority: high
assignee: sonnet
blocked_by: [2]
---

# Renderer notification store and shared navigation helper

The renderer-side cache of main's notification list, plus the one navigation
helper that both native-notification clicks and in-app list rows go through.
No UI in this ticket — that is ticket 5.

## 1. `src/store/notification-store.ts`

Zustand store following the self-initializing pattern of
`src/store/task-store.ts`: subscriptions registered inside the `create()`
factory, and an `init()` invoked from there.

```ts
interface NotificationState {
  notifications: NotificationRecord[];   // newest first, as main sends them
  loading: boolean;
  loaded: boolean;
  unreadCount: number;                   // derived on every set
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  clear: () => Promise<void>;
}
```

- On create: `window.electronAPI?.notifications.onChanged(list => ...)` replaces
  the array wholesale. Main owns the list; the renderer never mutates its copy
  speculatively — actions call IPC and wait for the broadcast, exactly as
  ADR-136 has main own the unseen sets.
- `init()` calls `notifications.getAll()` once and populates state. Guard on
  `window.electronAPI?.notifications` being absent (the store is imported in
  tests and in non-Electron contexts) and swallow errors into
  `{ loading: false }`, same as `task-store`'s init.
- `unreadCount` is recomputed whenever `notifications` is set — do not keep it
  as independent state that can drift.

## 2. `src/utils/notification-navigation.ts`

```ts
export async function navigateToNotification(
  record: NotificationRecord,
): Promise<void>
```

- Mark the record read first (`useNotificationStore.getState().markRead(id)`).
- `record.target?.type === "task"`: find the task in
  `useTaskStore.getState().tasks`, falling back to
  `window.electronAPI.tasks.get(taskId)`. If found, call `navigateToTask(task)`
  from `src/utils/task-navigation.ts` — do not reimplement its project /
  workspace / tab / pane resolution. If the task is gone, do nothing further.
- `record.target?.type === "url"`: `window.electronAPI.shell.openExternal(url)`.
- `target === null`: mark read and stop.

## 3. Wire the native click

Register `window.electronAPI.notifications.onNavigate(async (id) => ...)` in
the notification store's create-time subscriptions: resolve the record from
state (falling back to a `getAll()` refetch if it is not there yet) and call
`navigateToNotification`. This is the handler for the `notifications:navigate`
broadcast ticket 2 added.

## 4. Remove the old task-navigation listener

`src/store/task-store.ts` registers
`window.electronAPI?.notifications.onNavigateToTask(...)` at store-create time.
That channel no longer exists after ticket 2 — delete the listener and any
import it alone was keeping alive. `navigateToTask` is still used elsewhere in
that file; leave the rest untouched.

## 5. PR emit passes `kind`

`src/utils/pr-notifications.ts` — `notifyPrEvent` already has `event.kind` in
scope. Pass it through in the `notifications.show({...})` payload. The toast
fallback branch is unchanged.

## Tests

Add `src/store/__tests__/notification-store.test.ts` or extend the existing
utils test folder as the repo's conventions dictate. Cover the store's
`onChanged` replacement and `unreadCount` derivation, and
`navigateToNotification` routing task vs url vs null targets (mock
`window.electronAPI`). `src/utils/__tests__/pr-notifications.test.ts` asserts on
the `notifications.show` payload — update its expectations for the new `kind`
field.

## Files to touch

- `src/store/notification-store.ts` — new.
- `src/utils/notification-navigation.ts` — new.
- `src/store/task-store.ts` — remove the `onNavigateToTask` listener.
- `src/utils/pr-notifications.ts` — pass `kind` in the show payload.
- `src/utils/__tests__/pr-notifications.test.ts` — update payload expectations.
- `src/store/__tests__/notification-store.test.ts` — new.
