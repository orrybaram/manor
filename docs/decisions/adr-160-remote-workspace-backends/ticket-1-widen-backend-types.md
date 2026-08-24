---
title: Widen consumers from LocalBackend to WorkspaceBackend
status: todo
priority: high
assignee: haiku
blocked_by: []
---

# Widen consumers from LocalBackend to WorkspaceBackend

Several modules import the concrete `LocalBackend` class where they only use the
`WorkspaceBackend` interface. Nothing can be substituted until those references are
widened. This is a mechanical, no-behavior-change prep step.

Change every `LocalBackend` type annotation/import listed below to `WorkspaceBackend`
imported from `electron/backend/types`. Do NOT change `app-lifecycle.ts:173`'s
construction (`new LocalBackend(client)`) — only its type usage if any.

Verify `pnpm lint` and `npx tsc --noEmit -p tsconfig.electron.json` pass. If a consumer
turns out to use a member that is not on the `WorkspaceBackend` interface, do not widen
that one — leave it and note it in your commit body.

## Files to touch
- `electron/webview-server.ts` — `import type { LocalBackend }` (line ~29) and the
  `private backend: LocalBackend | null` field (~81) and constructor param (~92).
- `electron/ipc/webview.ts` — `import type { LocalBackend }` (~19) and the `backend?`
  param (~75).
- `electron/ipc/types.ts` — `import type { LocalBackend }` (~2) and the `backend` field (~37).
- `electron/routes/types.ts` — `import type { LocalBackend }` (~16) and the
  `backend: LocalBackend | null` field (~24).
- `electron/backend/index.ts` — re-export `WorkspaceBackend` if not already surfaced
  conveniently for these imports.
