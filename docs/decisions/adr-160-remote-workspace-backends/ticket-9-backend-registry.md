---
title: BackendRegistry and per-project hostId
status: todo
priority: critical
assignee: opus
blocked_by: [1, 8]
---

# BackendRegistry and per-project hostId

Replace the single-backend assumption with a keyed registry so local and remote projects
coexist in one window.

`electron/backend/registry.ts`:

```ts
export class BackendRegistry {
  get(hostId: string): WorkspaceBackend;         // "local" is always present
  async ensureConnected(hostId: string): Promise<void>;
  register(hostId: string, spec: HostSpec): void; // { kind: "ssh", target: string }
  list(): Array<{ hostId: string; status: "connected" | "connecting" | "error"; error?: string }>;
  onEvent(handler: (hostId: string, event: StreamEvent) => void): void;
}
```

Host specs persist alongside projects. Add `hostId?: string` to the project record in
`electron/persistence.ts` — **absent means `"local"`**, so existing `projects.json` files
load unchanged and no migration is needed. Add the host spec list to persistence as well.

In `electron/app-lifecycle.ts`, replace `const backend = new LocalBackend(client)` with
the registry, and resolve per-project backends where `projectManager`, `portScanner`, and
`diffWatcher` are constructed — those take a backend today and now need one per host, or
a resolver function. Prefer passing a resolver (`(hostId) => WorkspaceBackend`) over
constructing N watchers, and keep watcher polling per host so one unreachable host cannot
stall the others.

Panes resolve their backend via their project's `hostId`. Route `pty:*` IPC through that
resolution rather than the single client. The stream event handler must now tag events
with their `hostId` before broadcasting to renderer windows.

Keep the change behavior-neutral for local-only setups: with no remote hosts registered,
every path must behave exactly as it does today. Existing tests must pass.

## Files to touch
- `electron/backend/registry.ts` — new.
- `electron/persistence.ts` — `hostId` on projects (optional), host spec storage.
- `electron/app-lifecycle.ts` — registry instead of the `LocalBackend` singleton; resolver
  threading for `projectManager` / `portScanner` / `diffWatcher`; hostId tagging in the
  stream event handler.
- `electron/ipc/*.ts` — resolve backend per pane/project where `deps.backend` is used.
- `electron/routes/types.ts`, `electron/routes/*.ts` — same resolution for HTTP routes.
- `electron/persistence.test.ts` — cover the absent-hostId default.
