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

# ADR-029: Desktop Notifications for Agent Events

## Context

Manor currently only uses in-app toast notifications when an agent needs input or responds. When the app is in the background, users have no way to know an agent finished or needs attention without switching back to Manor. The dock badge (ADR-028) helps but is passive — users want proactive native macOS/Linux notifications.

The app already has:
- A `PreferencesManager` (`electron/preferences.ts`) with file-based persistence and IPC broadcasting
- A `usePreferencesStore` Zustand store in the renderer
- A "Notifications" section in App Settings with a dock badge toggle
- Task lifecycle tracking in `electron/main.ts` that broadcasts `task-updated` events
- A `navigateToTask()` utility that focuses the correct project/workspace/pane

## Decision

Add native desktop notifications using Electron's `Notification` API, triggered from the **main process** when agent status changes to `"responded"` or `"requires_input"`. Notifications only fire when the Manor window is **not focused** (`!mainWindow.isFocused()`).

### New preferences

Add three new boolean keys to `AppPreferences`:

| Key | Default | Description |
|-----|---------|-------------|
| `notifyOnResponse` | `true` | Notify when agent has a response |
| `notifyOnRequiresInput` | `true` | Notify when agent needs input |
| `notificationSound` | `true` | Play system sound with notifications |

### Notification content

- **Title**: `"Agent responded"` or `"Agent needs input"`
- **Body**: `"{taskName} — {projectName}"` (fall back to `"Agent"` / omit project if null)
- **Sound**: Controlled by `notificationSound` preference (Electron's `silent` option)
- **Click action**: Send IPC event `"notification:clicked"` with `taskId` to renderer → call `navigateToTask()` and focus window via `mainWindow.focus()`

### Trigger location

Notifications are sent from `broadcastTask()` in `electron/main.ts`, right where dock badge updates already happen. This is the single point where all task status changes flow through. Check previous status vs new status to avoid duplicate notifications on re-broadcasts.

### Settings UI

Add toggles to the existing "Notifications" section in `AppSettingsPage.tsx`:
- "Notify when agent responds" (checkbox for `notifyOnResponse`)
- "Notify when agent needs input" (checkbox for `notifyOnRequiresInput`)
- "Play notification sound" (checkbox for `notificationSound`)

These sit alongside the existing dock badge toggle.

## Consequences

- **Better**: Users get timely alerts when agents need attention, reducing idle wait time
- **Better**: Fully configurable — each notification type and sound can be toggled independently
- **Trade-off**: macOS may prompt for notification permission on first use — this is standard Electron behavior and requires no special handling
- **Risk**: Notification spam if many tasks complete rapidly — mitigated by only notifying on status *transitions* (not re-broadcasts of same status)

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
