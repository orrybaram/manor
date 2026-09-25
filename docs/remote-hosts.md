# Remote hosts

A project in Manor can live on another machine: a Linux box at Hetzner, an
exe.dev VM, a Mac mini under your desk, a Coder workspace. Anything you can
`ssh` into works. Every workspace in the project is a worktree on that box,
and every terminal and agent runs there. Manor on your laptop is the window
onto it.

What you get is agents that don't stop when your laptop does. Close the lid
and they keep working. Open it again and Manor reconnects. The sidebar then
shows what they did while you were away: final statuses and one notification
per agent.

Design background is in [ADR-160](decisions/adr-160-remote-workspace-backends/index.md)
(the transport and the remote daemon) and
[ADR-178](decisions/adr-178-always-on-remote-projects/index.md) (the
always-on behavior: hook journal, onboarding, ports, reconnect).

## Choosing a box

Manor doesn't host anything. You bring the box, and it only needs to be
reachable over ssh.

- **A VPS** (Hetzner CX33 or similar). Always on and cheap. A good default
  for agents that run overnight.
- **exe.dev, or a Coder workspace**. Fine, as long as the box stays up while
  you're away. Manor can't wake a box that has been stopped.
- **A spare Mac.** macOS hosts are supported. Enable Remote Login in System
  Settings → General → Sharing.

Managed sandbox providers (Fly Sprites, Daytona, E2B) aren't supported yet.
See [What isn't supported](#what-isnt-supported).

## Requirements

On the box:

- **Linux or macOS**, on x86_64 or arm64.
- **Node.js 20 or newer.** Manor looks for it on the plain ssh `PATH` first.
  If it isn't there, Manor checks your login shell (which picks up nvm, fnm
  or Homebrew set up in rc files) and the usual nvm/fnm/Homebrew locations.
- **git**, to clone the project and run worktrees.
- **A build toolchain on Linux**: `python3`, `make` and a C++ compiler.
  Manor's host package depends on `node-pty`, a native addon. `node-pty`
  ships no prebuilt binaries for Linux, so it's compiled during the first
  install. (macOS uses prebuilt binaries and needs no toolchain.)
  - Debian/Ubuntu: `sudo apt install python3 make g++`
  - Fedora/RHEL: `sudo dnf install python3 make gcc-c++`
- **Network access to the npm registry** during the first install, so the
  host package's dependencies can be installed.

On your laptop:

- **ssh key auth that works non-interactively.** Manor runs ssh with
  `BatchMode yes`, so it can't answer a password or passphrase prompt. If
  `ssh -o BatchMode=yes <host> true` works in a terminal, Manor will work.
  If your key has a passphrase, add it to your agent first (`ssh-add`, or
  `ssh-add --apple-use-keychain` on macOS).
- Host aliases, users, ports, keys and `ProxyJump` from `~/.ssh/config` all
  apply. Manor includes your config and doesn't change it.

## Adding a host and a remote project

1. **Add the host.** Open Project Settings → Host and enter an ssh target:
   `user@box`, `box` (an alias from `~/.ssh/config`) or `ssh://user@box:2222`.
   Manor starts connecting in the background. The first connection installs
   Manor's host package on the box (see [What runs where](#what-runs-where)),
   and the status bar shows its progress. On Linux the first install
   compiles `node-pty`, which can take a minute or two.
2. **Add the project.** Click **Open Project**, choose **On a remote host**,
   then pick the host. Enter the repo URL (`git@github.com:org/repo.git`,
   `https://…` or `ssh://…`) and a directory on the box (`~/code/repo`).
   Manor runs `git clone` on the box and shows its progress. If the directory
   already holds a clone of that repo, Manor adopts it instead.
3. **Check the health report.** After the clone, Manor checks the box:

   | Check | Command | Fix |
   |---|---|---|
   | Reach origin | `git ls-remote --heads origin` | `gh auth login`, or add a deploy key |
   | Claude CLI | `claude --version` plus an auth probe | `claude setup-token` |
   | Codex CLI | `codex --version` | `codex login` |
   | GitHub CLI | `gh auth status` | `gh auth login` |

   **Fix in terminal** opens a terminal on the box with the fix command
   typed. You sign in once, on the box, the same way you would over ssh.

After that the project works like a local one: workspaces, worktrees, agents,
the diff and branch watchers, the port list.

## What runs where

On the box, everything Manor installs lives under `~/.manor/`:

| Path | What it is |
|---|---|
| `~/.manor/host/` | The host package: the terminal daemon bundle and its `node_modules` |
| `~/.manor/bin/manor-host` | Launcher that pins the version and the absolute path to `node` |
| `~/.manor/remote/daemon/` | The remote daemon's socket, auth token, pid and log, plus the hook journal |
| `~/.manor/remote/hook-port` | The hook listener's port and token (mode 0600) |
| `~/.manor/hooks/notify.{sh,js}` | The hook script agents call |
| `~/.manor/sessions/` | Terminal scrollback |

The first connect also registers Manor's hooks in each agent CLI's config
(for example `~/.claude/settings.json`), the same way the desktop app does on
your laptop. MCP isn't registered on remote hosts.

If a Manor desktop also runs on the box, it isn't affected. Its daemon
(`~/.manor/daemon/`) and hook port file (`~/.manor/hook-port`) are separate.

On your laptop there's one ssh connection per host, multiplexed through a
ControlMaster socket in a temporary ssh config that Manor owns. Terminals,
git, file reads and port scans all use that connection.

**Nothing credential-related leaves your laptop.** Manor doesn't copy
`~/.ssh`, tokens or agent credentials to the box. It doesn't enable ssh agent
forwarding either: a forwarded agent is useless while the laptop is closed,
and it exposes your keys to anyone with root on the box. You sign in to
`gh`, `claude` and `codex` on the box yourself, once.

Upgrades happen automatically. When the app version changes, the next
connect installs the matching host package next to the old one and swaps it
in atomically. A failed install never replaces a working one.

## Laptop closed

- **Agents keep running.** They run on the box, not the laptop.
- **Status is journaled on the box.** An agent's hooks (started, working,
  finished, needs permission) go to a loopback listener run by the remote
  daemon. The daemon appends each one to
  `~/.manor/remote/daemon/hook-journal.ndjson`. The journal keeps at most
  5,000 entries, and none older than 7 days.
- **While you're away**, the host's projects show a *disconnected —
  reconnecting* badge. Its panes keep their last screen, read-only, under a
  banner. Manor retries with backoff (1s, 2s, 4s, and so on, up to every
  30s) for as long as the app is open. **Retry now** skips the wait.
- **When the connection is back**, Manor replays the journal from where it
  left off, then reattaches the panes from their snapshots. Replayed hooks
  update the sidebar exactly as live ones would. Notifications are
  coalesced: after a night away you get at most one per agent, for its
  final state.
- **If the box rebooted, or the daemon was restarted**, the daemon's
  terminals are gone, but files and agent session ids survive. Manor treats
  each lost pane as it does on an app relaunch: a fresh shell in the same
  directory, and for a pane that had an agent, that agent's resume command
  (for example `claude --resume <id>`). A notice says *Remote host restarted
  — N sessions resumed*.

A box that stops (a VM that was shut down, a machine that powered off) takes
running agents down with it, and they resume only when you reconnect.
Managed providers with keep-awake support are planned. See
[What isn't supported](#what-isnt-supported).

## Ports and forwarding

The port list scans remote hosts too. It uses `lsof` on macOS boxes, and on
Linux it uses `ss -ltnpH` plus `/proc/<pid>/cwd` to match each listener to a
workspace. A port only belongs to a workspace if the server runs as your
ssh user. A server running as another user shows up unattributed.

A dev server on the box listens on the box's loopback. When you open one of
its ports (a port badge, a browser pane, an agent's `navigate`), Manor asks
the ssh ControlMaster for a local forward
(`ssh -O forward -L 127.0.0.1:<local>:127.0.0.1:<remote>`) and loads the
local port instead. Forwards:

- bind to `127.0.0.1` on your laptop only, even if your ssh config sets
  `GatewayPorts yes`, so they're never exposed to your LAN;
- use the same port number locally when it's free;
- are recreated on reconnect, on the same local port when possible, so a
  page left open comes back at the same URL.

Forwards need `AllowTcpForwarding` on the box's sshd. It's enabled by
default. Agent status does **not** depend on forwarding: the hook journal
lives on the box.

## What isn't supported

- **Managed providers** (Fly Sprites, Daytona, E2B). Hosts are ssh only for
  now. Manor already models hosts as providers internally, so these can be
  added later.
- **Windows hosts.** Linux and macOS only.
- **Remote MCP.** Agents on the box don't get Manor's MCP server. The
  `manor` CLI and hooks work.
- **Open in editor**, and the directory picker, for remote paths. There's no
  file sync to a local editor either. Use your editor's own remote mode (VS
  Code Remote-SSH, Zed remote) against the same box.
- **One box per project.** A project's workspaces all live on its host.
- **Prewarmed sessions** are only kept for local projects.

## Security notes

- **The hook journal is a record of agent activity.** Entries hold hook
  metadata: event names, pane and session ids, tool names, notification
  kinds. Some agent hooks carry parts of prompts. The file is mode 0600
  under your home on the box, and capped as described above. That's the
  same exposure as the agents' own transcripts on that box.
- **The hook listener is loopback-only and authenticated.** It binds
  `127.0.0.1`, and every request must carry a random token that's written
  to `~/.manor/remote/hook-port` (mode 0600). Another user on a shared box
  can't read the token, so they can't flood the journal.
- **The daemon socket is token-gated too.** Its token is only reachable by
  someone who can already ssh in as you, and Manor reads it over that ssh
  connection. The daemon's `exec` request runs commands as you on the box.
  It's reachable only through that socket.
- **Nothing is copied to the box** except Manor's own host package.

## Troubleshooting

Each failure mode below is shown on the host (status bar and Project
Settings → Host) with the message quoted here.

**"ssh could not authenticate to …"**
Your key isn't available non-interactively. Check that
`ssh -o BatchMode=yes <target> true` works in a terminal. A key with a
passphrase needs to be in your agent: run `ssh-add` (macOS:
`ssh-add --apple-use-keychain ~/.ssh/id_ed25519`). Manor stops retrying
after this error. Click **Retry** once it's fixed.

**"…'s host key is not trusted yet" / "The host key for … has changed"**
Manor can't show ssh's "are you sure you want to continue connecting"
prompt. Run `ssh <target>` once from a terminal and accept the key. If the
key changed and you expected that, first remove the old one with
`ssh-keygen -R <host>`.

**"Node.js 20 or newer is required on … but no `node` was found"**
Install Node.js on the box (distro packages are often too old; nodesource,
nvm or fnm all work). Manor finds nvm/fnm installs through your login shell.
If yours is somewhere unusual, put it on the non-interactive ssh `PATH`,
e.g. by symlinking it into `/usr/local/bin`.

**"Node.js 20 or newer is required on …; found 18.x at …"**
Upgrade it, or install a newer version next to it with nvm/fnm. Manor picks
the newest one that's new enough.

**"… needs a build toolchain to compile node-pty, but … is missing"**
Linux only. Install the listed tools (`apt install python3 make g++` or
`dnf install python3 make gcc-c++`), then retry.

**"Installing Manor host on … failed during npm install"**
The message ends with npm's output. Common causes: no route to the npm
registry from the box, or a compiler error building `node-pty`. The previous
install, if any, is left in place.

**"The Manor host package for … is missing" (development builds)**
The app ships the host package as `dist-electron/manor-host-<version>.tgz`.
Packaged builds include it. In development, build it after `pnpm build`
with `node scripts/build-host-tarball.mjs`.

**The host keeps saying "reconnecting"**
The box is unreachable. Check `ssh <target> true` from a terminal. Manor
keeps retrying on its own; **Retry now** skips the wait.

**A port opens on your laptop instead of the box, or not at all**
The box's sshd must allow forwarding: `AllowTcpForwarding yes` (the default)
in `/etc/ssh/sshd_config`. Also check that the server listens on
`127.0.0.1` or `::1` on the box. Manor only forwards to the box's loopback.
`GatewayPorts` doesn't matter: Manor always binds forwards to `127.0.0.1`
locally.

**Agent status never changes for remote panes**
Check that the agent CLI on the box has Manor's hook registered
(`~/.claude/settings.json` should mention `~/.manor/hooks/notify.sh`). Any
problem registering it appears as a warning on the host. Also check that
`~/.manor/remote/hook-port` exists while connected.

To look under the hood on the box, the remote daemon's log is at
`~/.manor/remote/daemon/terminal-host.log`. `~/.manor/bin/manor-host
restart` stops the daemon (and its terminals). Manor starts a fresh one on
the next connect and recovers the panes as after a reboot.

## Testing

The remote-host suites run against a real sshd and are skipped unless
`MANOR_E2E_SSH=1`. `scripts/test-remote-e2e.mjs` provides the sshd, builds
the app and the host package, runs both suites, and cleans up:

```bash
# A private, unprivileged sshd on this Mac (the fast path). Its "remote"
# home is a temp dir; your ~/.manor and ~/.ssh are never touched.
node scripts/test-remote-e2e.mjs

# A Linux container (tests/e2e/remote-host/Dockerfile). Exercises the Linux
# paths: node-pty built from source, ss + /proc port scanning.
node scripts/test-remote-e2e.mjs --docker

# Options: --no-build, --vitest-only, --playwright-only, --smoke (check the
# sshd and exit), --serve (keep it up and print the env to export).
```

- `electron/terminal-host/__tests__/remote-ssh.e2e.test.ts` (vitest) covers
  the bridge: cold bootstrap, reinstall over a stale version, session
  lifecycle, hook journal replay across a dropped connection, snapshot
  resync without duplicated output, and a remote daemon restart.
- `tests/e2e/remote-host.spec.ts` (Playwright) covers the app: laptop-closed
  replay with a single notification, pane recovery with the agent's resume
  command after a remote restart, and port forwarding.

The harness writes an ssh config with two aliases, `manor-e2e` (the app's)
and `manor-e2e-direct` (the tests' side channel), and passes it to the tests
as `MANOR_E2E_SSH_CONFIG`. Manor's managed ssh config includes that file
ahead of `~/.ssh/config`. This is a **test-only** hook
(`electron/terminal-host/ssh-config.ts`) and is unset in normal use. To use
a box of your own instead, write such a file yourself and set
`MANOR_E2E_SSH=1` and `MANOR_E2E_SSH_CONFIG`. Use a throwaway account: the
suites delete `~/.manor` there.
