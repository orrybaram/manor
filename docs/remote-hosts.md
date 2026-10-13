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

And you don't have to wait for the lid to open. Every box runs its own small
Manor server, the **host server**. A phone paired with it sees that box's
agents and can type into them while your laptop sleeps (see
[Your phone with the lid closed](#your-phone-with-the-lid-closed)).

Design background is in [ADR-160](decisions/adr-160-remote-workspace-backends/index.md)
(the transport and the remote daemon),
[ADR-178](decisions/adr-178-always-on-remote-projects/index.md) (the
always-on behavior: hook journal, onboarding, ports, reconnect) and
[ADR-225](decisions/adr-225-host-server/index.md) (the host server).

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
| `~/.manor/bin/manor` | The `manor` CLI shim for remote use |
| `~/.manor/remote/daemon/` | The remote daemon's socket, auth token, pid and log, plus the hook journal |
| `~/.manor/remote/server/` | The host server: its socket, owner token, pid, logs, its own relay keys and paired phones, and what the desktop last told it (see [The host server](#the-host-server)) |
| `~/.manor/remote/hook-port` | The hook listener's port and token (mode 0600) |
| `~/.manor/remote/control-port` | The CLI relay's port and token (mode 0600) |
| `~/.manor/hooks/notify.{sh,js}` | The hook script agents call |
| `~/.manor/sessions/` | Terminal scrollback |

The first connect also registers Manor's hooks in each agent CLI's config
(for example `~/.claude/settings.json`), the same way the desktop app does on
your laptop. The `manor` CLI is installed at `~/.manor/bin/manor`. MCP isn't
registered on remote hosts.

If a Manor desktop also runs on the box, it isn't affected. Its daemon
(`~/.manor/daemon/`) and hook port file (`~/.manor/hook-port`) are separate.

On your laptop there's one ssh connection per host, multiplexed through a
ControlMaster socket in a temporary ssh config that Manor owns. Terminals,
git, file reads and port scans all use that connection.

**Your credentials stay on your laptop.** Manor doesn't copy `~/.ssh`,
tokens or agent credentials to the box. It doesn't enable ssh agent
forwarding either: a forwarded agent is useless while the laptop is closed,
and it exposes your keys to anyone with root on the box. You sign in to
`gh`, `claude` and `codex` on the box yourself, once. The one key the desktop
does send is its Web Push signing key, so the host server can send phone
notifications (see [Where secrets live](#where-secrets-live)). Integration
tokens such as Linear's API key go to the box only if you turn on "Use Linear
on \<host\>" (see [Integrations](#integrations)).

Upgrades happen automatically. When the app version changes, the next
connect installs the matching host package next to the old one and swaps it
in atomically. A failed install never replaces a working one.

## The host server

The host package ships two programs, and Manor keeps both running on the box:

- **The daemon** owns the terminals, their scrollback and the hook journal.
- **The host server** is a headless Manor server: Node, no Electron. It
  connects to the daemon on the box like any other client does, and runs
  what a phone needs to reach that box with your laptop closed. That covers
  agent status (it reads the same hook journal the desktop replays), the chat
  view, push notifications, and its own room on the Manor relay with its own
  paired phones.

They are separate processes on purpose. A daemon restart ends every terminal,
so the daemon only restarts when it has to. The host server restarts on every
Manor upgrade and takes nothing down with it.

**Lifecycle.** Every time the desktop connects to the box, it makes sure a
host server of the same version is running (`manor-host remote-bridge` and
`manor-host server-bridge` both check):

- If it's running and current, nothing happens.
- If it's from another version, Manor stops it and starts the new one. The
  daemon and its terminals are untouched.
- If it isn't running, Manor starts it, detached from the ssh session, so it
  keeps running after the desktop disconnects.

Like the daemon, it doesn't survive a reboot of the box. It comes back the
next time the desktop connects.

**The owner channel.** The desktop talks to the host server over the box's
existing ssh connection: `ssh <box> manor-host server-bridge`, which pipes to
the server's socket at `~/.manor/remote/server/server.sock`. Being able to
run that command as you over ssh is the authentication, so the desktop is the
server's **owner** and may do what a phone may not: pair and revoke phones,
and reset the server's keys. On every connect, and whenever they change, the
desktop sends it:

- **the manifest**: this box's projects, workspace names, linked issues, the
  last-known PR for each workspace, and the host's name;
- **a layout snapshot**: the tabs and panes of this box's workspaces.

The host server caches both, so a phone that connects with the lid closed
sees the sidebar and panes the desktop last had.

**Logs** are at `~/.manor/remote/server/logs/host-server.log` (rotated).
Startup failures, before that log is open, go to `host-server-spawn.log` in
the same directory. The first line of each start names the version and the
secret backend in use:

```
[host-server] 0.21.0 starting in /home/you/.manor/remote/server; secrets: systemd-creds
```

To restart it by hand, stop it with
`kill "$(cat ~/.manor/remote/server/server.pid)"`. A connected desktop notices
the owner channel drop and starts a fresh one within seconds; otherwise the
next connect does. Unlike `manor-host restart`, this doesn't touch the
terminals.

## Your phone with the lid closed

Pair a phone with the box from **Settings → Remote control**. Each remote host
has its own section there (see
[Pairing a phone with a host](remote-control.md#pairing-a-phone-with-a-host)).
That phone reaches the box's host server directly, through the Manor relay,
whether or not your laptop is awake.

**What it can do:**

- See the box's projects, workspaces and agents, with live status.
- Open any terminal and type into it.
- Use the chat view and reply, slash commands included.
- Get push notifications when an agent needs input or hits an error.
- Switch between hosts, if it's paired with more than one.

**What it can't do yet:**

- Create a workspace or launch an agent.
- Rearrange the layout (split, close, move tabs).

Creating a workspace or starting an agent from the phone says *Not yet
available from the phone for remote hosts* instead of failing, and the host
server refuses layout changes from a phone. These need the box to own its
projects and layout, and today the desktop owns them. A change made on the box
while the desktop is away would have nowhere to go.

Some more details:

- **Layout.** The phone shows the layout the desktop last sent. A terminal
  started after that, for example by an agent on the box, appears under a
  separate **Started while away** tab.
- **Terminal size.** While another client (the desktop, say) is attached to a
  terminal, the phone follows its size and shrinks the font rather than
  resizing it. When the phone is the only one attached, the terminal takes the
  phone's size.
- **Projects set up while the desktop was away** don't show up until the
  desktop next connects.
- **Issue and PR data** is the snapshot the desktop last sent, not live. See
  [Integrations](#integrations).

When the laptop opens again, the desktop replays the same hook journal the
host server reads, so the two agree on every agent's status.

## Where secrets live

The host server keeps a few secrets in `~/.manor/remote/server/`, each in its
own 0600 file:

| File | What |
|---|---|
| `relay-identity.enc` | The host server's relay identity: the keys that make its relay room its own, and the key phones check in the pairing QR |
| `remote-devices.enc` | Phones paired with this host. Device tokens are stored only as SHA-256 hashes |
| `remote-vapid.enc` | The Web Push signing key. The desktop sends its own, so one browser push subscription works for every host. A host uses a key of its own until the desktop's arrives |
| `secret-backend` | Which backend encrypted the files above |
| `owner-token` | The token the owner channel presents on the server's socket. New on every start |

Device tokens are hashed, so the secrets worth protecting are the relay
identity and the push key. Someone who already has your account on the box can
use them. That person can also reach your terminals, your repos and your
agents' own credentials, so the keys add little to that. Encryption protects
against the files leaving the box: a backup, a disk image, a volume snapshot.

If you suspect the box was compromised, use **Reset pairing keys** in that
host's section of Settings → Remote control. It gives the host server a new
relay identity, which moves it to a new room and disconnects every phone paired
with it. Pair them again afterwards.

### Encrypting pairing keys

The host server encrypts its keys with the first of these that works on the
box, checked on first start (and, while it is on plaintext, on every start):

1. **`systemd-creds --user`** (systemd 256 or newer). It encrypts with a key
   derived from the machine's own credential secret, and uses the TPM2 chip
   when the machine has one. You can decrypt the files without root, but a
   copy of them is useless on any other machine.
2. **libsecret**, when an unlocked Secret Service keyring (GNOME Keyring,
   KWallet) is reachable over D-Bus and `secret-tool` is installed. Manor keeps
   one random key in the keyring and encrypts the files with it (AES-256-GCM).
   A server started over ssh usually has no D-Bus session, so on a headless
   box this rarely applies.
3. **Plaintext files, mode 0600**, as a last resort. This is never silent:
   the host's section of Settings → Remote control says *Pairing keys on
   \<host\> are stored unencrypted*.

**To check which backend a box uses:**

- Look for the warning in Settings → Remote control. No warning means the keys
  are encrypted.
- On the box, run `cat ~/.manor/remote/server/secret-backend`, which prints
  `{"backend":"systemd-creds"}`, `"libsecret"` or `"plaintext"`.
- Or read the `secrets:` field on the startup line of
  `~/.manor/remote/server/logs/host-server.log`.

**To find out whether systemd-creds would work**, run this on the box:

```bash
systemd-creds --version | head -1        # needs 256 or newer
echo probe | systemd-creds --user encrypt --name=manor - - >/dev/null && echo ok
```

**The choice is remembered.** Once systemd-creds or libsecret has encrypted
the keys, the host server keeps using it. If it later stops working, the server
reports an error naming it, and doesn't fall back to writing plaintext.

**Plaintext upgrades itself.** Plaintext is only ever a last resort, so a host
server on plaintext checks for systemd-creds and then libsecret every time it
starts. When one works, it encrypts the existing key files with it and
switches to it. Your phones stay paired. So to move a box off plaintext,
make one of them work (for example, upgrade systemd to 256 or newer), then
restart the host server:

```bash
kill "$(cat ~/.manor/remote/server/server.pid)"
```

A connected desktop starts it again within seconds. Check that the warning in
Settings → Remote control is gone, or that `secret-backend` names the new
backend.

## Integrations

Every integration is one of two kinds:

- **Host-native**: the credential is already on the box because your agents
  use it, such as `gh` and git. The host server runs these with the box's own
  sign-in, in the checkout, and nothing gets copied. If `gh` isn't signed in on
  the box, Manor says so ("gh isn't signed in on \<host\>") rather than
  failing. PR badges for a remote workspace come from the box's `gh`.
- **User-delegated**: a credential you gave Manor itself, such as Linear's API
  key. It stays on your laptop unless you choose otherwise. Settings → Remote
  control → the host has a **Use Linear on \<host\>** switch (shown when Linear
  is connected on this computer). Turning it on copies your Linear key to the
  box, sealed by the box's secret backend (see
  [Where secrets live](#where-secrets-live)); Linear has no narrower key to
  send. Until then every Linear call on the host answers "Linear isn't turned
  on for \<host\>". Turning the switch off, or **Reset pairing keys**, deletes
  the copy. Linear on your laptop for a remote project always uses your laptop's
  key; the copy is only for phones and the box's own server.

### Linear without a key on the box

If you don't want the key on the box, skip the switch and use Linear's MCP
server in the agent instead. It needs nothing from Manor: add the Linear MCP
server to the agent's own configuration on the box and sign in there. The
trade-off is that Manor doesn't see those issues, so there is no issue link on
the workspace and no "start work from an issue" flow.

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

## The `manor` CLI

Agents on the box can run the `manor` CLI to look up their project, manage
workspaces and folders, link issues, and list and launch agents. The CLI is
installed at `~/.manor/bin/manor` and is on PATH in every remote PTY.

Requests go to a loopback listener run by the remote daemon. The listener reads
the request and relays it over the existing ssh connection to Manor on your
laptop, which processes it the same way it handles requests from the local
client. The result comes back over the same connection.

This only works while your laptop is connected. If it disconnects, CLI commands
fail with "Manor desktop is not connected to this host" — there is no queueing
or journal for CLI requests, unlike hooks.

No new port is opened on your laptop and it doesn't require `AllowTcpForwarding`
in sshd's config. The relay keeps other users on a shared box out: the token is
written to `~/.manor/remote/control-port` (mode 0600).

The CLI only reaches the box's own projects. `list-projects` and
`list-agents` show the box's projects and the agents in them, and a command
that names a project or workspace on another host (your laptop included)
fails with "No project '…' on this host". So a box can't create or delete
worktrees on your laptop, or launch agents there.

Only these routes are relayed:

| Area | What the CLI can do |
|---|---|
| Context | Find the project and workspace the terminal is in |
| Projects | List them, read one, list its branches (read-only) |
| Workspaces | List, create (one or a batch), delete, rename, hide, reorder, move into a folder |
| Folders | Everything: list, create, rename, move, delete |
| Issues | List and read issues, create one, link and unlink them from workspaces |
| Agents | List agents, launch one in a workspace |

Everything else fails with "`<METHOD> <path>` isn't available from remote
hosts". That covers adding, deleting or updating projects, converting or
quick-merging workspaces, git, panes, browser panes, system commands, and
controlling other agents' sessions (sending input, interrupting, ending).

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
- **Remote MCP.** Agents on the box don't get Manor's MCP server. Hooks
  work, and the `manor` CLI works for the commands listed in "The `manor` CLI"
  section.
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
- **Nothing of yours is copied to the box** except Manor's own host package
  and the desktop's Web Push signing key (see
  [Where secrets live](#where-secrets-live)).
- **The host server's socket is token-gated.** Its owner token is a 0600 file
  that's new on every start, and only `manor-host server-bridge`, run over
  your ssh connection, presents it. A phone reaches the host server only
  through its relay room, with a device token, and can't call the owner-only
  methods: pairing, revoking, resetting keys.

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

**"Phone access needs the host to reconnect"** (Settings → Remote control)
The desktop can't reach the host server right now: the box is unreachable,
or the server isn't running. It clears when the host reconnects. If it
stays, read `~/.manor/remote/server/logs/host-server-spawn.log` and
`host-server.log` on the box.

**"Pairing keys were encrypted with …, which is no longer available"**
The secret backend the host server chose on its first start no longer works,
for example because the keyring is locked or `systemd-creds` was removed. The
keys are left as they are. Bring the backend back and restart the host server.
If it is gone for good, start over with new keys. This disconnects the phones
paired with this host:

1. Quit Manor on your laptop. A connected desktop would restart the host
   server within seconds, with the old keys.
2. On the box, stop the server and delete its keys:

   ```bash
   kill "$(cat ~/.manor/remote/server/server.pid)"
   cd ~/.manor/remote/server && rm -f secret-backend relay-identity.enc remote-devices.enc remote-vapid.enc
   ```

3. Open Manor. Once the host connects, pair your phones again.

**A phone paired with a host can't connect**
In the host's section of Settings → Remote control, check that the summary
says *relay connected*. The host server dials the Manor relay from the box, so
the box needs outbound HTTPS to `relay.manor.sh`.

To look under the hood on the box, the remote daemon's log is at
`~/.manor/remote/daemon/terminal-host.log`, and the host server's is at
`~/.manor/remote/server/logs/host-server.log`. `~/.manor/bin/manor-host
restart` stops the daemon (and its terminals), but not the host server.
Manor starts a fresh daemon on the next connect and recovers the panes as
after a reboot.

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
- `tests/e2e/host-server.spec.ts` (Playwright) covers the host server with the
  laptop gone. The desktop starts an agent on the box and pairs a browser with
  the box's host server through a local relay (`wrangler dev`). Then the
  desktop loses the box, and the browser alone checks three things: the agent
  is listed with its status, a hook fired on the box changes that status, and
  typing reaches the agent's terminal. When the desktop reconnects, its agent
  state must match the host server's. It needs the private-sshd target, not
  `--docker`, because the box must reach the relay on the test machine's
  loopback. It also needs `pnpm build:web:relay` and Node 22 on `PATH`
  (wrangler).

The Playwright specs share one box, so the harness runs them with one worker.
The box's host server dials `MANOR_RELAY_URL` from its environment, and the
harness sets that to a closed local port, so a test box never dials the
production relay. `host-server.spec.ts` points it at its own relay through
`~/.manor-e2e/env` on the box, which the harness's ssh wrapper sources.

The harness writes an ssh config with two aliases, `manor-e2e` (the app's)
and `manor-e2e-direct` (the tests' side channel), and passes it to the tests
as `MANOR_E2E_SSH_CONFIG`. Manor's managed ssh config includes that file
ahead of `~/.ssh/config`. This is a **test-only** hook
(`electron/terminal-host/ssh-config.ts`) and is unset in normal use. To use
a box of your own instead, write such a file yourself and set
`MANOR_E2E_SSH=1` and `MANOR_E2E_SSH_CONFIG`. Use a throwaway account: the
suites delete `~/.manor` there.
