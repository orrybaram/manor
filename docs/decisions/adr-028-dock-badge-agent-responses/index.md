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

# ADR-028: Dock Badge for Agent Responses

## Context

When agents finish responding (status = "responded"), there's no OS-level notification. The user has to visually check the app to see if agents have responded. macOS supports `app.dock.setBadge(count)` to show a badge count on the dock icon — this is the standard way native apps signal pending attention.

The app currently has no general-purpose preferences persistence system. Settings are scattered across individual files (theme, projects, window bounds). We need a lightweight app preferences store to make this feature configurable.

## Decision

### 1. App Preferences Persistence (`electron/preferences.ts`)

Create a simple JSON-backed preferences store in `~/Library/Application Support/Manor/preferences.json`. It stores app-wide boolean/string/number settings. Initial schema:

```typescript
interface AppPreferences {
  dockBadgeEnabled: boolean; // default: true
}
```

Expose via IPC: `preferences:get`, `preferences:set`, `preferences:onChange`.

### 2. Dock Badge Logic (in `electron/main.ts`)

In the existing `agentHookServer.setRelay` callback and `broadcastTask` flow:
- After any task update, count tasks where `status === "active"` AND `lastAgentStatus === "responded"`.
- Call `app.dock.setBadge(count.toString())` (or `""` for zero).
- Only apply if `dockBadgeEnabled` preference is true.
- Clear badge when the app window gains focus (user is looking at the app).

### 3. Settings UI (`src/components/AppSettingsPage.tsx`)

Add a "Notifications" section to the existing App Settings page with a toggle for "Show dock badge for agent responses". Uses a simple checkbox/toggle pattern matching existing settings UI styles.

### 4. Renderer preferences store (`src/store/preferences-store.ts`)

Zustand store that loads preferences on init and subscribes to changes via IPC. Provides `usePreferencesStore` hook for React components.

## Consequences

- **Better**: Users get OS-level visibility into agent responses without checking the app.
- **Better**: Establishes a reusable app preferences pattern for future settings.
- **Tradeoff**: macOS-only for dock badge (Linux has no equivalent via Electron's `app.dock`). The setting will be hidden on non-macOS platforms.
- **Risk**: Badge count must stay in sync with task state — we recompute from the task list on every update to avoid drift.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
