---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-162: Notification center

Closes #163.

## Context

Notifications in Manor are fire-and-forget. If the native OS notification is
missed — app unfocused and the banner auto-dismissed, Do Not Disturb on, the
user away from the machine — the signal is gone permanently. There is no
durable record of what happened while you were away.

What exists today:

- **Native OS notifications** — `electron/notifications.ts`. Two public entry
  points, both funnelling into one private `presentNotification()`:
  - `maybeSendNotification(task, prevStatus, newStatus, ...)` for agent
    `responded` / `requires_input`, called from the hook-relay effect applier
    (`electron/hook-relay-effects.ts`, `UpdateTaskActiveStatus`) via a closure
    in `electron/app-lifecycle.ts`.
  - `showPrNotification(payload, ...)` for PR events, invoked *from the
    renderer* over `notifications:show` — `src/hooks/usePrWatcher.ts` →
    `deliverPrNotifications` → `notifyPrEvent` in `src/utils/pr-notifications.ts`.
  - `presentNotification()` returns `false` and shows nothing when the main
    window is focused. That focus check is the single arbiter (ADR-147): the
    renderer cannot see its own focus reliably because `document.hasFocus()` is
    false whenever a `<webview>` pane holds focus.
- **In-app toasts** — `src/store/toast-store.ts`, purely ephemeral, in-memory.
- **Unseen state** — two `Set<string>` in main (`unseenRespondedTasks`,
  `unseenInputTasks`), mirrored as a renderer cache in `src/store/task-store.ts`
  (ADR-136). This answers *"is something unseen right now"*, per task. It does
  not answer *"what happened, and when"*, and it collapses: a task that goes
  `requires_input` → answered → `responded` leaves one bit, not two events.

Nothing is persisted. The gap is at its widest exactly where the current design
is most deliberate: a notification suppressed because the window was focused is
never recorded anywhere durable, even though the user may have been looking at
a different pane the whole time.

The issue also flags #109 (clicking a desktop notification does not navigate).
Today the native-click path for agent notifications sends
`notification:navigate-to-task` with a task id, handled in `task-store.ts`;
PR notifications call `shell.openExternal` directly from main. Two click paths,
neither of which the in-app list could reuse.

## Decision

Add a **notification store owned by main, persisted to disk, cached by the
renderer** — the same ownership model as ADR-136's unseen sets — plus a bell
entry point in the sidebar titlebar that opens a popover listing the history.

### 1. Record shape

New module `electron/notification-store.ts`:

```ts
export type NotificationKind =
  | "agent-responded"
  | "agent-requires-input"
  | "pr-comment"
  | "pr-approved"
  | "pr-changes-requested"
  | "pr-checks-failed";

export type NotificationTarget =
  | { type: "task"; taskId: string }
  | { type: "url"; url: string };

export interface NotificationRecord {
  id: string;               // crypto.randomUUID()
  kind: NotificationKind;
  title: string;            // same string the OS banner shows
  body: string;
  timestamp: string;        // ISO
  read: boolean;
  target: NotificationTarget | null;
}
```

`NotificationStore` mirrors `TaskManager` (`electron/task-persistence.ts`):
in-memory array newest-first, debounced write, prune on construction and on
append. Persisted to `notifications.json` under `manorDataDir()` via a new
`notificationsFile()` getter in `electron/paths.ts` — it has no external
reader, so it belongs in the data dir, not `~/.manor` (see the rule in
`paths.ts`).

**Retention**: capped at 200 records and 30 days, whichever bites first,
enforced in `append()` and on load. Constants in the module, no new preference
— the issue asks for a cap, not for a knob.

### 2. Record on emit — one site, not two

Recording moves *inside* `presentNotification()`, **before** the focus
early-return. `presentNotification` gains a `record: { kind, target }` field
alongside `title` / `body`, appends the record, and only then decides whether
to show a banner.

This is the load-bearing choice. Recording at the two public entry points would
work today and rot tomorrow; recording inside the one function every native
notification already passes through makes it structurally impossible to add a
notification path that does not appear in the list. It also gets the
suppressed-because-focused case for free, which is the main gap the issue
identifies.

Preference gates stay where they are — `maybeSendNotification` returns early
when `notifyOnResponse` / `notifyOnRequiresInput` is off, and
`deliverPrNotifications` filters on the `notifyOnPr*` prefs before calling.
A notification the user has switched off is not recorded. The list is
"everything that would have notified you", not "everything that could have".

`showPrNotification`'s IPC payload grows a `kind: PrNotifyEventKind` field so
main can map it to a `NotificationKind`; `src/utils/pr-notifications.ts`
already has `event.kind` in hand at the call site.

### 3. One owner, one broadcast

New `electron/ipc/notifications.ts`, registered from `electron/ipc/index.ts`,
with `notificationStore` added to `IpcDeps` and constructed in
`electron/app-lifecycle.ts`:

- `notifications:getAll` → `NotificationRecord[]`, newest first
- `notifications:markRead(id)`
- `notifications:markAllRead()`
- `notifications:clear()`

Every mutation — including `append` from `presentNotification` — broadcasts a
single `notifications:changed` event carrying **the full list**. The list is
hard-capped at 200 records, so a full-array broadcast costs nothing and removes
the entire class of renderer-drift bugs that per-delta events invite. One
channel, one shape, one owner; the renderer never mutates its own copy
speculatively.

### 4. Unified click path (and #109)

The native notification's `onClick` currently branches: task notifications send
`notification:navigate-to-task` with a task id, PR notifications call
`shell.openExternal` in main. Both are replaced by a single
`notifications:navigate` broadcast carrying the record id. The renderer
resolves it through one shared helper:

`src/utils/notification-navigation.ts` — `navigateToNotification(record)`:
- `target.type === "task"` → resolve the task from `task-store`, falling back
  to `tasks.get(id)`, then `navigateToTask(task)`
  (`src/utils/task-navigation.ts`)
- `target.type === "url"` → `window.electronAPI.shell.openExternal(url)`
- marks the record read either way

The in-app list rows call the same helper. Native click and list click become
the same code path, which is what makes clicking a row navigate correctly
without a second implementation — and is the plumbing #109 needs. This ADR does
not claim to close #109 (its root cause is unconfirmed), but it removes the
duplicated path that made it hard to reason about.

The old `notification:navigate-to-task` channel, its `onNavigateToTask` preload
binding, and its listener in `src/store/task-store.ts` are removed rather than
left alongside — two navigation paths is exactly the drift this consolidates.

### 5. Renderer store

`src/store/notification-store.ts`, zustand, following `task-store.ts`'s
self-initializing shape: subscribes to `notifications:changed` and
`notifications:navigate` at create time, fetches the snapshot in an `init()`
kicked off from the store factory. State: `notifications`, `unreadCount`
(derived), `loading`. Actions proxy straight to IPC — main is the writer.

### 6. UI

Bell button in the **sidebar titlebar**, beside the existing back/forward nav
controls in `src/components/sidebar/Sidebar/Sidebar.tsx`, using `Button` and
`Tooltip` from `src/components/ui/` per the project rule. An unread count badge
sits on the bell.

It opens `src/components/notifications/NotificationsPopover.tsx`, a Radix
`Popover` following the `PrPopover` pattern (click-triggered, not hover). The
sidebar's vertical space is already contended by Projects / Tasks / Ports; a
popover keeps history one click away without permanently taxing that column.

Rows are grouped by day. `getDateBucket` / `BUCKET_ORDER` are lifted out of
`src/components/sidebar/TasksView/TasksView.tsx` into
`src/utils/date-buckets.ts` and imported by both — one bucketing rule, not a
copy that diverges. Each row shows a kind icon, title, body, relative time
(`relativeShortThenDate` from `src/utils/relative-time.ts`) and an unread dot.
Header carries "Mark all read" and "Clear".

### 7. Relationship to the unseen sets

The notification list sits **alongside** the ADR-136 pulse indicators; it does
not replace them. They answer different questions — the pulse is *per-task
presence right now*, the list is *history*. Marking a notification read does
not clear a task's unseen flag; navigating to the task does, through
`navigateToTask`, which already calls `tasks.markSeen`. The dock badge stays
driven by the unseen sets alone.

## Consequences

**Better**

- A missed notification is recoverable. Suppressed-because-focused events —
  the widest gap today — land in the list like any other.
- One recording site inside `presentNotification` means new notification kinds
  are recorded by construction, not by remembering to.
- One click path for native banners and list rows removes a duplicated
  navigation implementation and gives #109 somewhere sane to be fixed.
- Day bucketing exists once instead of twice.

**Worse / riskier**

- A third piece of persisted main-owned state (`notifications.json`) alongside
  `tasks.json` and `preferences.json`, with its own retention policy to reason
  about.
- Broadcasting the full list on every mutation is O(list) per notification.
  Correct-by-construction, but it does mean a burst of agent status changes
  ships the array repeatedly. The 200-record cap keeps this negligible; if it
  ever is not, the fix is delta events, and this ADR should be revisited rather
  than patched.
- Removing `notification:navigate-to-task` is a breaking change to the preload
  surface. Blast radius is three files, but it must land atomically with its
  replacement.
- The list is per-device by design. Nothing syncs across machines, and the
  remote-control relay (ADR-161) is untouched — a phone still learns about
  agent status through its own path.
- Retention is a hard-coded constant. If users want longer history the honest
  answer is a preference, which this ADR deliberately defers.

**Explicitly out of scope**

- Changing when notifications fire, or adding new notification kinds.
- Cross-device sync.
- Closing #109 (same plumbing, separate diagnosis).

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
