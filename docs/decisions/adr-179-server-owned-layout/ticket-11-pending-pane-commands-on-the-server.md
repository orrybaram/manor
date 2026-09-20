---
title: Pending pane commands live on the server; start-agent no longer needs a window
status: in-progress
priority: high
assignee: opus
blocked_by: [5]
---

# Pending pane commands live on the server; start-agent no longer needs a window

Regression found by ticket 5. `POST /panes/split` and `POST /tabs` accept
`command` / `paneCommand`, and MCP `split_pane` / `new_tab` (agent fan-out,
ADR-176) rely on it. It worked by seeding the *sending renderer's*
`pendingPaneCommands` / `pendingStartupCommands` map, which that renderer's
own mount effect read back after `pty.create`. A route has no renderer to
seed, so since ticket 5 the argument is validated and silently ignored.
Before ticket 5 the route 503'd without a window; now it lies.

The same mechanism is why `POST /agents` (`start-agent`) still round-trips
through a window: `launchAgentInWorkspace` seeds a startup command the same
way. Fix both with one server-side map.

## Server

- `electron/layout/pending-commands.ts` (new, owned by `LayoutStore` or
  beside it): `Map<paneId, { text: string; kind: "shell" | "agent-startup" }>`
  with `set`, `take`, `clear(paneId)`. Not persisted — a pending command
  that outlives the process is a surprise, not a feature.
- Producers: the structural routes that accept `command`/`paneCommand`
  (`panes.ts`), and the renderer through a new `layout.setPendingCommand(
  paneId, text, kind)` (IPC + bridge, `MUTATING` with `paneId` as target) so
  the desktop's own new-tab-with-command and agent launches use the same
  path. Delete the store's `pendingPaneCommands` / `pendingStartupCommands`
  and the mount-effect readers in `useTerminalLifecycle.ts`.
- Consumer: the lifted `ptyCreate` in `electron/ipc/pty.ts` — after
  `createOrAttach` resolves and the session is **fresh** (not a warm
  reattach: use the snapshot/`prewarmed` signals the create already returns),
  `take(paneId)` and `writeAfterReady(paneId, text + "\r")`
  (`terminal-host/client.ts` has it). Exactly once: a second viewer's
  `pty.create` for the same pane finds nothing to take. Respect the prewarm
  path — read `prewarm-manager.ts` and `consumePrewarmed`/`commandInjected`
  before touching it; if a prewarmed session already had the agent command
  injected, do not inject again.
- `POST /agents` (`start-agent`, `routes/agents.ts`; read ADR-176 first) —
  `new-tab` command through `layoutStore.apply` + `setPendingCommand(paneId,
  agentCommand + prompt, "agent-startup")`, then whatever `startAgent` does
  today for agent registration, **without** `proxyToRenderer`. Keep the
  reply shape (`StartedAgent`). If ADR-176's reliability guarantees (pane
  mounted before the prompt lands, verified by process argv) depend on the
  renderer round-trip in a way the server cannot reproduce, keep the
  renderer path for `start-agent` only and say precisely why.

## Tests

- `pending-commands.test.ts` — set/take/once.
- `electron/routes/panes.test.ts` — `POST /panes/split` with `command`
  records a pending command for the minted pane.
- `ipc/pty` or `ws-bridge` test — `ptyCreate` on a fresh session writes the
  pending command once via `writeAfterReady`; a reattach does not; a second
  create for the same pane does not.
- E2E: from the CLI/HTTP (`tests/e2e/helpers/local-api.ts`), `POST /tabs`
  with `command: "echo mark:pending-cmd"` and assert the mark appears in the
  new pane's scrollback on the desktop. If `start-agent` moved, extend the
  existing fan-out/agent E2E accordingly.

## Files to touch
- `electron/layout/pending-commands.ts` (+test) — new
- `electron/routes/panes.ts`, `electron/routes/agents.ts` (+tests) — producers; `start-agent` server-side
- `electron/ipc/pty.ts` — consumer in `ptyCreate`
- `electron/ipc/layout.ts`, `electron/remote-control/ws-handlers.ts`, `electron/preload.ts`, `src/electron.d.ts` — `layout.setPendingCommand`
- `src/store/app-store.ts`, `src/hooks/useTerminalLifecycle.ts`, `src/lib/agent-prompt-launch.ts` (if it seeds) — delete renderer-side pending maps, call the server instead
- `tests/e2e/*.spec.ts` — one pending-command scenario
