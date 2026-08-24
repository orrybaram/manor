---
type: adr
status: proposed
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

# ADR-160: Remote workspace backends

## Context

Manor's terminals run on the machine Manor runs on. Every pane, every agent, every
`git` invocation is bound to the laptop. Close the lid and the agents stop. A project
that wants a beefier box, a Linux box, or a box that stays awake has no path.

[herdr](https://github.com/herdrdev/herdr) solves this and the way it does so is
worth copying, because the mechanism turns out to be small. herdr already runs a
client/server split locally: a background server owns the PTYs and exposes two unix
sockets in `~/.config/herdr/` — `herdr.sock` (NDJSON automation API) and
`herdr-client.sock` (binary render protocol for the TUI). `herdr --remote user@box`
does not introduce a new architecture. It swaps a transport:

1. `src/remote/attach.rs` ssh's `uname -sm`, resolves `{linux,macos} × {x86_64,aarch64}`.
2. It locates or installs `~/.local/bin/herdr` on the remote — fetching
   `https://herdr.dev/latest.json`, verifying sha256, streaming the binary over ssh
   stdin to `$dest.tmp.$$`, then renaming atomically. It refuses to attach across a
   `PROTOCOL_VERSION` mismatch.
3. `SshStdioBridge` binds a *local* unix socket at mode 0600. On each accept it spawns
   `ssh -T target 'exec ~/.local/bin/herdr remote-client-bridge'` and pumps
   socket ↔ ssh stdio.
4. The remote side (`src/remote/host_unix.rs`, 69 lines) pumps its own stdin/stdout ↔
   the remote `herdr-client.sock`.
5. The unchanged client is pointed at the local socket. It cannot tell local from remote.

Notable trims around the edges: an ssh ControlMaster socket in a throwaway managed ssh
config so repeat connections reuse one TCP session; a handshake read timeout of 5s local
but 60s remote because cold TCP+kex+auth happens inside that window; sniffing
`Permission denied (publickey` to print a `ssh-add` hint; bridging the local clipboard as
a `ClipboardImage` message so pasting a screenshot into a remote agent still works.

Manor has independently arrived at the same shape. `electron/terminal-host/` is a
detached Node daemon owning the PTYs, listening on `~/.manor/daemon/terminal-host.sock`,
authenticating with a 0600 token file, negotiating a version handshake (ADR-116), and
speaking NDJSON `ControlRequest`/`ControlResponse` plus a stream socket carrying
`StreamEvent`s. Snapshots and scrollback already survive detach.

Two things follow.

First, Manor's protocol is *already* the shape that survives an ssh stdio pipe. NDJSON
over a stream socket needs no reframing. And because xterm.js in the renderer does the
terminal emulation, Manor would ship raw PTY bytes rather than herdr's per-frame cell
grids — herdr's own remote path still defaults to `SemanticFrame` (full grid, 2 MB frame
cap), with server-diffed `TerminalAnsi` merely opt-in behind `HERDR_RENDER_ENCODING`.
Manor's thin-client boundary is naturally cheaper.

Second, `electron/backend/types.ts` already declares `WorkspaceBackend`
(`{ pty, git, shell, ports, connect(), disconnect() }`) with exactly one implementation,
`LocalBackend`, constructed in exactly one place (`app-lifecycle.ts:173`). The seam for
this work was carved before anyone needed it.

Where Manor should *not* copy herdr: herdr runs one server per session and the client
attaches to one. It cannot mix hosts. Manor is workspace-centric — the interface is
literally named `WorkspaceBackend` — so the end state is a registry of hosts, with a
local project, a remote build box, and a cloud sandbox open side by side in one window,
one sidebar showing every agent's state regardless of which machine it runs on. That is
the thing herdr's architecture forecloses and Manor's does not. Remote-as-a-single-mode
is the degenerate case of remote-as-a-host-type, so we build the general one.

### Correction to earlier analysis

An earlier pass in this conversation claimed the agent hook relay must move into the
host process because remote agents cannot reach the `AgentHookServer` HTTP port in
Electron main. That is wrong, and the correct answer is much cheaper. We already spawn
ssh; `ssh -R <remotePort>:127.0.0.1:<hookPort>` reverse-forwards the existing local hook
server onto the remote box, and the daemon's existing `updateEnv` control request sets
`MANOR_HOOK_PORT` for remote PTYs. The hook server stays exactly where it is. What *does*
need to happen remotely is the one-time setup Electron main currently runs against the
local filesystem — `ShellManager.setupZdotdir()`, `ensureHookScript()`,
`registerAllAgents()` (`app-lifecycle.ts:211-213`) — which writes the hook script and
patches `~/.claude/settings.json` and friends. The remote daemon runs those on itself.

## Decision

Introduce remote hosts as a `WorkspaceBackend` implementation reached over an
SSH-bridged copy of the existing daemon protocol, and replace the single-backend
assumption with a keyed registry.

### 1. Transport abstraction

`TerminalHostClient` (`electron/terminal-host/client.ts`) currently hardcodes
`net.connect(SOCKET_PATH)`, token-file reads, and daemon spawn. Extract:

```ts
interface HostTransport {
  ensureRunning(version?: string): Promise<void>;
  connectControl(): Promise<Duplex>;
  connectStream(): Promise<Duplex>;
  authToken(): Promise<string>;
  dispose(): Promise<void>;
}
```

`LocalTransport` preserves today's behavior byte for byte. The client keeps its
NDJSON framing, request mutex, pending-request map, and version handshake untouched —
it only stops knowing what a unix socket is.

### 2. `remote-bridge` mode in the daemon entry

`electron/terminal-host/index.ts` gains an argv mode: `manor-host remote-bridge
[--stream]`. It ensures the local (i.e. remote-box) daemon is running via the existing
spawn path, reads the token file, writes a single-line `{"type":"bridgeHello","token":…,
"daemonVersion":…}` preamble on stdout, then transparently pumps stdin/stdout ↔ the
daemon's unix socket. This mirrors herdr's `host_unix.rs`. The token is only reachable
by someone who already holds ssh access to that account, so surfacing it on that channel
grants nothing new.

### 3. `SshTransport`

Spawns `ssh -T <target> 'exec ~/.manor/bin/manor-host remote-bridge'` per logical
connection (one control, one stream), with a ControlMaster socket in a Manor-owned
throwaway ssh config directory so both share a single TCP session. Reads the
`bridgeHello` line, then hands the raw duplex to the client. Copies herdr's operational
details: 60s handshake timeout for remote (vs 5s local), `Permission denied (publickey|
keyboard-interactive|password` sniffing to emit an `ssh-add` hint, keepalives on.

The reverse hook forward (`-R`) is attached to the same ssh invocation.

### 4. Remote bootstrap

`electron/backend/remote-bootstrap.ts`: over ssh, `uname -sm` to resolve the platform,
then `~/.manor/bin/manor-host --version` to compare against `app.getVersion()`. On
missing or mismatched, install.

Unlike herdr we cannot ship one static binary — the daemon depends on `node-pty`, a
native addon. Rather than own a cross-compilation matrix, v1 **requires Node ≥ 20 on the
remote host** and installs a version-pinned `manor-host` npm tarball, built from
`electron/terminal-host/` at release time and streamed over ssh stdin into a temp dir,
then `npm install --omit=dev` there and atomically renamed into place. `node-pty`
resolves its own platform prebuilds during that install. A single-binary path (Node SEA
per platform, downloaded and sha256-verified like herdr) is a later optimization, not a
blocker.

The bridge refuses to attach across a daemon/client version mismatch, reusing the
existing handshake rather than inventing a second version scheme.

### 5. Injectable exec, then `RemoteBackend`

`electron/backend/exec.ts` is currently one line (`execFileAsync`). Widen it to an
injected `Exec` surface covering the three things the local backends actually reach for:
`execFile`, `spawn` (streaming, for `pushStream`), and `readFile`. `LocalGitBackend`,
`LocalShellBackend`, and `LocalPortsBackend` take it as a constructor dependency and
otherwise do not change — all command construction stays put.

The daemon then grows `exec` and `execStream` control requests, and `RemoteBackend`
implements `WorkspaceBackend` by handing those same backend classes a remote `Exec` that
routes through the bridge. Git, shell, and port logic is written once and runs on either
side of the wire.

### 6. Backend registry and project hosts

Replace the `LocalBackend` singleton with a `BackendRegistry` keyed by `hostId`.
Projects gain an optional `hostId` (absent ⇒ `"local"`, so migration is a no-op default).
Panes resolve their backend through their project. Consumers currently typed against the
concrete `LocalBackend` (`webview-server.ts`, `ipc/webview.ts`, `ipc/types.ts`,
`routes/types.ts`) widen to `WorkspaceBackend` first, as an isolated no-behavior-change
step.

### 7. Remote agent-hook setup

A `bootstrap` control request makes the remote daemon run `ShellManager.setupZdotdir()`,
`ensureHookScript()`, and `registerAllAgents()` against its own filesystem, so remote
agent CLIs are configured to call back through the reverse-forwarded port.

### Explicitly out of scope

Remoting the webview and MCP servers; a remote-aware directory picker
(`dialog:openDirectory`) and `shell:openInEditor`; Windows remote hosts; and the phone /
relay surface (a separate ADR — Manor's existing `read_session`, `send_to_session`,
`list_panes`, `list_tasks` HTTP surface is already the right API for it, and it needs no
part of this work).

## Consequences

**Better.** Agents survive the laptop closing, because they were never on the laptop.
A project can name a machine and Manor follows. Git, shell, and port logic becomes
host-agnostic by construction rather than by discipline. The registry means hosts
compose — local and remote projects coexist in one window with one agent-state sidebar,
which is the capability herdr's single-server model cannot reach. The transport
extraction and the injectable `Exec` are both improvements on their own terms even if
remote hosts were cancelled tomorrow.

**Worse.** Every operation gains a failure mode that did not exist: the network. Latency
now sits between a keystroke and a PTY, and between `git status` and its answer — the
diff and branch watchers poll, so they need backoff and staleness handling that a local
`execFile` never demanded. Error surfacing gets harder because a failure can now mean
"ssh died", "remote daemon died", "remote box rebooted", or "your key has a passphrase",
and the UI must say which. The daemon gains a second deployment target, so daemon
changes become a versioned wire contract with an installed base rather than a detail we
can change freely — the existing handshake contains this, but only if we keep honoring it.

**Risks.** Requiring Node on the remote box is a real adoption tax that herdr does not
pay; if that bites, the Node SEA path is the escape hatch and the bootstrap module is
where it would land. `exec`/`execStream` over the daemon socket is an arbitrary command
execution surface — it is reachable only through the token-gated socket behind ssh, but
it deserves that scrutiny in review. Reverse port forwarding for hooks depends on the
remote sshd permitting it; `AllowTcpForwarding no` will break agent status on that host
and needs a clear diagnostic rather than silently idle panes. Path handling is the
quiet one: `projects.json`, worktree paths, and layout persistence all store absolute
paths that now belong to a specific host, and mixing them up will produce confusing
failures — hence `hostId` on the project rather than a global mode flag.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
