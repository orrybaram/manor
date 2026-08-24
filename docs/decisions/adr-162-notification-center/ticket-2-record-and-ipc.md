---
title: Record every notification at emit, expose it over IPC
status: todo
priority: critical
assignee: opus
blocked_by: [1]
---

# Record every notification at emit, expose it over IPC

Wire `NotificationStore` (ticket 1) into the notification emit path and expose
it to the renderer. Cross-cutting: main's notification module, the IPC layer,
app bootstrap, preload, and the renderer type declarations.

## 1. Record inside `presentNotification`

`electron/notifications.ts` currently has a private `presentNotification()`
that both public entry points funnel through, and which **returns early when
the main window is focused**. Recording must happen *before* that early return
— a suppressed-because-focused notification is exactly the case the feature
exists for.

- Give the module a `NotificationStore` via a setter called from
  app-lifecycle (`setNotificationStore(store)`), or accept it as a parameter
  threaded from the existing call sites — pick whichever fits the module's
  current style with least ceremony, but there must be exactly one recording
  site.
- Extend `presentNotification`'s `opts` with
  `record: { kind: NotificationKind; target: NotificationTarget | null }`.
  Append the record first, then run the focus check and banner logic.
- Do **not** record when the preference gate already rejected the event —
  `maybeSendNotification` returns before calling `presentNotification` when
  `notifyOnResponse` / `notifyOnRequiresInput` is off. Leave those gates alone.

Mapping at the two entry points:

- `maybeSendNotification` — `kind` is `"agent-responded"` or
  `"agent-requires-input"` depending on which branch set the title;
  `target` is `{ type: "task", taskId: task.id }`.
- `showPrNotification` — its payload grows `kind: PrNotifyEventKind`
  (`"comment" | "approved" | "changes-requested" | "checks-failed"`). Map it to
  the matching `NotificationKind` (`pr-comment`, `pr-approved`,
  `pr-changes-requested`, `pr-checks-failed`). `target` is
  `{ type: "url", url }` when a url is present, else `null`.

## 2. Unified click path

Replace both native-click behaviours with one broadcast.

- `presentNotification`'s `notification.on("click")` handler keeps
  `mainWindow.show()` / `.focus()`, then sends
  `notifications:navigate` with the **record id** to the main window.
- Delete the `onClick` closure that sends `notification:navigate-to-task` in
  `maybeSendNotification`, and the `shell.openExternal` closure in
  `showPrNotification`. Navigation is now the renderer's job for both kinds
  (ticket 3 implements the handler).
- Remove the now-dead `notification:navigate-to-task` channel: its
  `onNavigateToTask` binding in `electron/preload.ts` and its declaration in
  `src/electron.d.ts`. Its renderer listener in `src/store/task-store.ts` is
  removed in ticket 3 — leave that file alone here.
  Note: `shell` may become an unused import in `electron/notifications.ts`;
  drop it if so.

## 3. IPC

New `electron/ipc/notifications.ts` exporting `register(deps: IpcDeps)`,
following the shape of `electron/ipc/tasks.ts`:

- `notifications:getAll` → `NotificationRecord[]`
- `notifications:markRead(id)` — `assertString(id, "id")` via `../ipc-validate`
- `notifications:markAllRead()`
- `notifications:clear()`

**Every mutation broadcasts `notifications:changed` with the full list.** That
includes `append` from the emit path — put the broadcast in one helper in this
module (or a small exported function main can call) so there is a single
send-site, the way `sendTaskUpdate` is the single send-site for `task-updated`.
The list is capped at 200 records, so a full-array broadcast is deliberate:
it makes renderer drift impossible.

The existing `notifications:show` handler in `electron/ipc/misc.ts` must accept
and forward the new `kind` field. Keep the handler where it is; just widen the
payload it passes to `showPrNotification`. It still returns whether a banner
was presented — the renderer's toast fallback depends on that (ADR-147).

## 4. Bootstrap and preload

- `electron/ipc/types.ts` — add `notificationStore: NotificationStore` to
  `IpcDeps`.
- `electron/ipc/index.ts` — import and call `notificationsIpc.register(deps)`
  from `registerAllIpc`.
- `electron/app-lifecycle.ts` — construct the `NotificationStore` alongside the
  other managers, hand it to `notifications.ts` (the setter from step 1), and
  pass it in the `IpcDeps` object. Note this file registers IPC modules
  individually as well as through `registerAllIpc` — follow whichever path the
  surrounding code actually uses so the module is registered exactly once.
- `electron/preload.ts` — under the existing `notifications` key:
  `getAll`, `markRead`, `markAllRead`, `clear`, `onChanged(cb)` and
  `onNavigate(cb)` using the existing `onChannel` helper. Keep `show`, and
  widen its payload type with `kind`. Remove `onNavigateToTask`.
- `src/electron.d.ts` — mirror all of the above on the `notifications` member.
  Re-declare `NotificationRecord` / `NotificationKind` / `NotificationTarget`
  here in the style the file already uses for `TaskInfo` (this file is the
  renderer's own declaration surface — do not import from `electron/`).

## Verification

`npm run typecheck` and the existing electron test suite must pass. Existing
tests that construct `IpcDeps` fixtures (`electron/__tests__/tasks-*.test.ts`,
`relay-subagent-tracking.test.ts`) will need the new dep added — update them
minimally with a real `NotificationStore` pointed at a temp dir, or a small
stub, whichever those fixtures already do for other managers.

## Files to touch

- `electron/notifications.ts` — record inside `presentNotification`; `kind` on
  the PR payload; unified click broadcast; drop the two old click closures.
- `electron/ipc/notifications.ts` — new. Handlers + the single broadcast helper.
- `electron/ipc/misc.ts` — forward `kind` through `notifications:show`.
- `electron/ipc/index.ts` — register the new module.
- `electron/ipc/types.ts` — `notificationStore` on `IpcDeps`.
- `electron/app-lifecycle.ts` — construct, inject, register.
- `electron/preload.ts` — new bindings; remove `onNavigateToTask`.
- `src/electron.d.ts` — declaration surface for the above.
- `electron/__tests__/*.test.ts` — update `IpcDeps` fixtures.
