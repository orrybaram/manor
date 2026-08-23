---
title: Remote agent hooks — reverse forward, env, and daemon bootstrap
status: todo
priority: high
assignee: opus
blocked_by: [5, 9]
---

# Remote agent hooks — reverse forward, env, and daemon bootstrap

Agent status (working / blocked / idle) comes from agent CLIs POSTing to
`AgentHookServer`, an HTTP server in Electron main whose port is handed to PTYs as
`MANOR_HOOK_PORT` (`app-lifecycle.ts:412-414`). A remote agent cannot reach that port,
and the remote box has no hook script or patched agent config.

The hook server does **not** move. Instead:

1. **Reverse forward** — pick a free remote port and pass
   `-R <remotePort>:127.0.0.1:<agentHookServer.hookPort>` on the ssh invocation
   (`SshTransport` already accepts `opts.hookForward` from ticket 5). Wire the real port
   in from `app-lifecycle.ts` when registering an ssh host.
2. **Env** — after connecting, call the daemon's existing `updateEnv` control request
   with `{ MANOR_HOOK_PORT: String(remotePort) }` so remote PTYs spawn with a hook port
   that resolves. Note `LocalPtyBackend.updateEnv` is currently a no-op
   (`local-pty.ts:62`) — implement it for the remote path and confirm the daemon side
   applies `envOverrides` at spawn (`session.ts:230-235`).
3. **Bootstrap** — add a `{ type: "bootstrap" }` control request. The daemon runs, against
   its own filesystem, the equivalent of `app-lifecycle.ts:211-213`:
   `ShellManager.setupZdotdir()`, `ensureHookScript()`, `registerAllAgents()`. Extract
   those three into a module the daemon can import without pulling in Electron —
   `electron/paths.ts` is already Electron-free and states that rule, so follow it.
   `agent-connectors.ts` and `agent-hooks.ts`'s `ensureHookScript` must be checked for
   Electron imports and split if they have any. Respond `{ type: "bootstrapped",
   agents: string[] }` listing which connectors were registered.
4. **Diagnostics** — if the reverse forward was refused (`AllowTcpForwarding no`), agents
   run but never report status. Surface that as a distinct host warning rather than
   letting panes sit silently idle.

Add a test asserting that a bootstrapped daemon writes the hook script and that
`updateEnv` reaches session spawn env.

## Files to touch
- `electron/terminal-host/types.ts` — `bootstrap` / `bootstrapped` variants.
- `electron/terminal-host/index.ts` — handle `bootstrap`.
- `electron/terminal-host/bootstrap-host.ts` — new; Electron-free zdotdir + hook script +
  connector registration, shared with `app-lifecycle.ts`.
- `electron/agent-connectors.ts`, `electron/agent-hooks.ts` — split out anything
  Electron-dependent so the daemon can import the rest.
- `electron/backend/local-pty.ts` — implement `updateEnv`.
- `electron/app-lifecycle.ts` — pass the real hook port when registering an ssh host.
