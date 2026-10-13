---
title: Move process-global server state onto the server
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Move process-global server state onto the server

ADR-227 D1. This ticket is a pure refactor: no behavior changes on the
desktop.

Several modules assume there is one server per process. Make each one take
its state from whoever composes the server.

- **`electron/renderer-broadcast.ts`.** The global `rendererSinks`,
  `addRendererBroadcastSink` and `publishRendererBroadcast` stay only as the
  desktop's adapter. Callers that the shared server will own take a
  `BroadcastBus` (already exists: `createBroadcastBus()`), not the global.
- **`electron/projects/progress.ts`.** `emitSetupProgress` uses
  `publishToRenderer`. Inject a publish function instead, through
  `ProjectManager`'s ctx or a constructor option.
- **`electron/notifications.ts`.**
  - Move `unseenInputAgents` and `unseenRespondedAgents` into an
    `UnseenAgents` object owned by the composer. The host already keeps its
    own sets in `electron/host-server/agents.ts`; make both use the new
    object.
  - Replace `setNotificationStore` and `setStatsStore` with constructor
    injection.
- Also check `electron/pty-attachments.ts`. Its module-level listeners must
  be per-server, or be documented as safe to share.

The existing host-server tests run two servers in one process, so they must
still pass.

## Files to touch
- `electron/renderer-broadcast.ts`
- `electron/projects/progress.ts`
- `electron/projects/project-manager.ts`
- `electron/notifications.ts`
- `electron/agent-status/pipeline.ts`
- `electron/host-server/agents.ts`
- `electron/app-lifecycle.ts`
- `electron/pty-attachments.ts`

## Carried over from ticket 1
- **Move `agents` and `notifications` into `SERVER_METHODS`.** Ticket 1 left
  both namespaces in `DESKTOP_METHODS` (`electron/bridge/handlers.ts`),
  because both still import `electron/notifications.ts`, which imports
  `electron` at runtime.
  - `bridge/handlers/agents.ts` uses `markAgentNotificationsRead`,
    `sendAgentUpdate` and `updateDockBadge`.
  - `bridge/handlers/notifications.ts` uses `showPrNotification`,
    `sendNotificationsUpdate` and the related functions.
  - Once the notification state is server-scoped, reach these through
    `ServerDeps` fields (a notifier object the desktop fills in), then move
    both namespaces into `electron/bridge/server-methods.ts`.
  - `notifications.show` focus-checks the caller's window. Make that check
    an optional dep, or keep only that one method desktop-only.
  - The electron-free bundle test must still pass.
