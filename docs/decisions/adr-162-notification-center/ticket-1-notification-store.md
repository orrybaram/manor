---
title: Main-side NotificationStore with persistence and retention
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Main-side NotificationStore with persistence and retention

Create the persisted notification record store in Electron main. This ticket is
pure model + persistence — no IPC, no wiring into the notification emit path
(that is ticket 2), no UI.

Mirror the shape and conventions of `electron/task-persistence.ts`
(`TaskManager`): a class holding in-memory state, a debounced save timer, a
synchronous flush, and pruning applied at construction.

## Types

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
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  timestamp: string; // ISO
  read: boolean;
  target: NotificationTarget | null;
}
```

## API

```ts
export class NotificationStore {
  constructor(dataDir?: string);           // defaults to manorDataDir()
  append(input: {
    kind: NotificationKind;
    title: string;
    body: string;
    target: NotificationTarget | null;
  }): NotificationRecord;                  // generates id + timestamp, read: false
  getAll(): NotificationRecord[];          // newest first
  getById(id: string): NotificationRecord | null;
  markRead(id: string): boolean;           // true when it changed
  markAllRead(): void;
  clear(): void;
  unreadCount(): number;
  flushNow(): void;
}
```

Behaviour requirements:

- Records are stored newest-first. `append` unshifts.
- `id` via `crypto.randomUUID()`, `timestamp` via `new Date().toISOString()`.
- **Retention**: `const MAX_NOTIFICATIONS = 200` and `const MAX_AGE_DAYS = 30`,
  module constants. Prune runs on load and after every `append`: drop records
  older than `MAX_AGE_DAYS`, then truncate to the newest `MAX_NOTIFICATIONS`.
- Persist to `notificationsFile()` as `{ notifications: NotificationRecord[] }`.
  A malformed or missing file yields an empty store — catch and return `[]`,
  same as `TaskManager.loadState`. Drop records that fail a minimal shape check
  (missing `id`/`kind`/`timestamp`) rather than throwing.
- Writes are debounced the way `TaskManager` debounces (same timer pattern and
  delay); `flushNow()` writes synchronously.
- No Electron imports in this module — it is plain Node, like
  `task-persistence.ts`.

## Tests

Add `electron/__tests__/notification-store.test.ts` (vitest, matching the
conventions of the existing `electron/persistence.test.ts` /
`electron/task-persistence.test.ts`). Point the store at a temp dir. Cover:

- append → getAll returns newest-first
- markRead flips exactly one record and returns false for an unknown id
- markAllRead / clear / unreadCount
- count pruning at the 200 cap
- age pruning at the 30-day boundary (construct records with an old timestamp)
- reload from disk round-trips records
- a corrupt `notifications.json` yields an empty store instead of throwing

## Files to touch

- `electron/notification-store.ts` — new. The class, types, constants.
- `electron/paths.ts` — add `notificationsFile()` returning
  `path.join(manorDataDir(), "notifications.json")`. Put it next to the other
  data-dir getters (`tasksFile`, `preferencesFile`), not in the home-dir
  section — this file has no external reader.
- `electron/__tests__/notification-store.test.ts` — new.
