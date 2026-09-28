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

# ADR-189: The `manor` CLI on remote hosts

## Context

Agents running on a remote host (ADR-160, ADR-178) should be able to manage
Manor the way local agents do: create workspaces, create and move folders,
list projects, link issues, list and launch agents. They cannot, for two reasons.

1. **The CLI isn't installed on the box.** `ensureManorCli`
   (`electron/manor-cli-install.ts`) runs only on the laptop. The host tarball
   (`scripts/build-host-tarball.mjs`) ships `terminal-host-index.js`,
   `pty-subprocess.js` and `agent-hook.js`, and nothing else. The remote
   `~/.manor/bin` is on every remote PTY's PATH (`session.ts`), but only
   `manor-host` is in it.
2. **Even if it were installed, it couldn't connect.** The CLI talks
   unauthenticated HTTP to `127.0.0.1:<MANOR_WEBVIEW_PORT>` on the laptop
   (`electron/mcp/http-client.ts` → `WebviewServer` →
   `handleControlRequest` in `electron/routes/index.ts`). Nothing routes from
   the box back to the laptop: the daemon strips `MANOR_WEBVIEW_PORT` from the
   env the client pushes, and ADR-178 dropped reverse forwards (`-R`) because
   they fail when sshd has `AllowTcpForwarding` off.

Meanwhile the SessionStart hint (`electron/scripts/agent-hook.js`) tells
remote agents the CLI is on PATH, and `docs/remote-hosts.md` says it works.
Both are wrong today.

Agent hooks already solved a similar problem. The remote daemon runs a
token-protected loopback listener (`terminal-host/hook-listener.ts`,
port and token in `~/.manor/remote/hook-port`) and relays each event to main
over the existing ssh stream connection (`hookEvent` stream events →
`HostHookFeed`). The CLI needs a request/response version of that.

MCP on remote hosts, and the pane, webview and system routes, are out of scope.

## Decision

Relay the CLI's HTTP requests through the remote daemon over the existing
stream connection. Main runs each request through the same
`handleControlRequest` the local server uses, restricted to an allowlist of
project, workspace, folder and agent routes.

### 1. Daemon: a control relay listener

- New `electron/terminal-host/control-relay-listener.ts`, modelled on
  `hook-listener.ts`. It binds `127.0.0.1:0`, mints a 32-byte token, and
  writes `<port>\n<token>\n` (0600) to a new `remoteControlPortFile()` =
  `~/.manor/remote/control-port` (`electron/paths.ts`). It sets
  `MANOR_CONTROL_PORT_FILE` in the daemon's `process.env` so every PTY inherits
  it. Requests without a matching `x-manor-control-token` header get a 403.
  Bodies are capped at 1 MiB.
- Each accepted request becomes
  `{ type: "controlRequest"; id; method; path; body }` (a new `StreamEvent`,
  where `path` includes the query) and is sent to the **relay stream**: the
  most recently opened stream socket that sent `enableControlRelay`. The
  listener waits for the matching `controlResponse` and answers the CLI with
  its status and JSON body.
  - **No relay stream** (laptop disconnected, or an app too old to relay):
    answer `503 { error: "Manor desktop is not connected to this host" }`
    right away.
  - **No response within 30s**, or the relay stream closes while requests are
    still waiting: answer 504 or 503.
- New `StreamCommand`s, main → daemon:
  `{ type: "enableControlRelay" }` and
  `{ type: "controlResponse"; id; status; body }`.
- `remoteRole.onStartup` (`daemon-role.ts`) starts the listener next to the
  hook listener, with the same retry in `bootstrap()`. The local daemon role
  does not start it.

**No `TERMINAL_HOST_PROTOCOL` bump.** A bump restarts remote daemons and ends
their sessions (ADR-185). The change is backward compatible in both
directions:
- **Old daemon, new app:** the daemon silently drops the unknown stream
  commands and never emits `controlRequest`. The CLI there finds no
  `MANOR_CONTROL_PORT_FILE` and fails as it does today.
- **New daemon, old app:** the app never sends `enableControlRelay`, so the
  CLI gets the 503.

### 2. Main: answer relayed requests

- `HostConnection` / `RemoteHostConnection` (`electron/backend/host-connection.ts`)
  sends `enableControlRelay` each time its stream connects. It hands
  `controlRequest` events to a `ControlRelaySink(hostId, request)`, and sends
  the result back as `controlResponse`.
- New `electron/control-relay.ts`:
  - `REMOTE_CONTROL_ALLOWLIST`: method and path patterns (below).
  - `handleRelayedControlRequest(deps, hostId, req)`: refuse paths off the
    allowlist with `403 { error: "<route> isn't available from remote hosts" }`,
    otherwise call `handleControlRequest` with a synthetic `URL`, a `json`
    callback that captures the result, and `readBody` returning `req.body`.
    Unhandled → 404. A thrown handler → 500.
- `WebviewServer` exposes the merged `ControlDeps` it already builds for its
  own requests (a public `getControlDeps()`), so the relay uses the same
  dependencies. `ControlDeps` gains an optional per-request `callerHostId`.
- `app-lifecycle.ts` wires the sink into the backend registry, so each
  `RemoteBackend`'s connection receives it.
- **`/context` becomes host-aware** (`routes/context.ts`). When
  `callerHostId` is set, only projects on that host are candidates for the cwd
  match. This removes the ambiguity when a local project has the same path.
  Resolving by pane id is unchanged, since pane ids are unique across hosts.

**Allowlist**. Anything else returns 403:

| Area | Routes |
|---|---|
| Context | `GET /context` |
| Projects (read) | `GET /projects`, `GET /projects/:id`, `GET /projects/:id/branches` |
| Workspaces | `GET/POST/DELETE /projects/:id/workspaces`, `POST …/workspaces/batch`, `…/rename`, `…/hidden`, `…/reorder`, `…/folder` |
| Folders | all of `routes/folders.ts` |
| Issues | `GET /projects/:id/issues`, `GET /projects/:id/issues/:ref`, `GET/POST/DELETE /projects/:id/workspaces/issues`, `POST /projects/:id/issues` |
| Agents | `GET /agents`, `POST /agents` |

Left out on purpose:
- adding, deleting or updating projects, and `convert-main`;
- quick-merge, git, panes, tabs, webview and system routes;
- agent session control (`/sessions/*`). A remote agent should not be able
  to drive other agents' input or kill them.

The list is data, so widening it later is a one-line change.

### 3. CLI transport

`electron/mcp/http-client.ts`: when `MANOR_CONTROL_PORT_FILE` is set, read the
port and token from that file on each call and send the token in
`x-manor-control-token`. Do not fall back to `MANOR_WEBVIEW_PORT` or
`~/.manor/webview-server-port`, because a Manor desktop on the same box is not
the one that owns this terminal. A refused connection reports "Manor's remote
daemon isn't reachable. Reconnect the host in Manor". A 503 or 403 body's
`error` is shown as is. Without the variable, behaviour is unchanged.

### 4. Ship the CLI to the box

- `scripts/build-host-tarball.mjs`: add `manor-cli.js` to the bundles. It is
  already electron-free, and the script's electron check enforces that.
- `electron/backend/remote-bootstrap.ts`: the `commit` step also writes
  `~/.manor/bin/manor`, a shim running `exec <pinned node> "$HOME/.manor/host/manor-cli.js" "$@"`.
  It uses the same pinned node path as the `manor-host` shim, and the same
  atomic tmp-and-rename.

### 5. Hint and docs

- **SessionStart hint** (`agent-hook.js`): when `MANOR_CONTROL_PORT_FILE` is
  set, i.e. the terminal is on a remote host, emit a remote variant. It keeps
  the CLI, workspace, folder and batch-create guidance, says pane, browser and
  system commands aren't available on remote hosts, and drops the MCP sentence.
- **`docs/remote-hosts.md`**: document the relay, `~/.manor/bin/manor`,
  `~/.manor/remote/control-port`, and the allowlist. Correct the "`manor` CLI
  works" line.

## Consequences

- Agents on remote hosts can create workspaces and folders, link issues, and
  list and launch agents with the same `manor` commands as locally.
- It reuses the connection, auth pattern and handlers that already exist:
  there is no new port on the laptop, no sshd requirement, and no second
  implementation of any route.
- **The CLI only works while the laptop is connected.** Unlike hooks, requests
  can't be journaled for later. They fail fast with a 503 and a clear message.
- **New trust edge:** code running as the user on the box can now change the
  laptop's Manor state (sidebar, workspaces, launching agents on that host).
  The token file (0600) keeps other users on a shared box out. The allowlist
  bounds what the box's own user can do. Worktrees are created on the box
  itself, and launched agents run on the box.
- **The stream is shared.** Relayed requests share the stream connection with
  terminal data. Requests are small and rare, so this should not affect typing.
- **Rollout:** the relay turns on only once the remote daemon runs a build
  with this change. The host package updates with the app, but a running
  daemon keeps its old code until it restarts. Until then remote terminals
  have `manor` on PATH but no `MANOR_CONTROL_PORT_FILE`, and the CLI reports
  that it cannot reach Manor.
- **Stale tokens:** the port file is re-read on every call, so a daemon
  restart does not break the CLI in shells that were already open.
- **Out of scope:** MCP on remote hosts. It would reuse this transport, since
  the MCP server shares `http-client.ts`, plus a registration step.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
