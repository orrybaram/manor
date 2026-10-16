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
Manor server, the **host server**, and it is the authority for that box: it
owns the box's projects, workspaces, folders, linked issues, layout and
agents, and your laptop is a client of it. A phone paired with it can see the
box's agents, type into them, create a workspace and launch a new agent while
your laptop sleeps (see
[Your phone with the lid closed](#your-phone-with-the-lid-closed)).

Design background is in [ADR-160](decisions/adr-160-remote-workspace-backends/index.md)
(the transport and the remote daemon),
[ADR-178](decisions/adr-178-always-on-remote-projects/index.md) (the
always-on behavior: hook journal, onboarding, ports, reconnect) and
[ADR-225](decisions/adr-225-host-server/index.md) (the host server),
[ADR-227](decisions/adr-227-host-ownership-flip/index.md) (the host owns its
host) and [ADR-229](decisions/adr-229-hosts-we-start/index.md) (hosts Manor
starts itself, surviving a reboot, asleep hosts).

## Choosing a box

Manor doesn't host anything. You bring the box. Either it is already running
and reachable over ssh, or you give Manor a **recipe**: your own commands that
start it, stop it and delete it (see [Host recipes](hosts/recipes.md)).

- **A VPS** (Hetzner CX33 or similar). Always on and cheap. A good default
  for agents that run overnight.
- **exe.dev, or a Coder workspace**. Fine, as long as the box stays up while
  you're away. Manor can only start a box that was stopped if it has a
  recipe for it.
- **A spare Mac.** macOS hosts are supported. Enable Remote Login in System
  Settings → General → Sharing.
- **A container or a pod** that Manor starts itself, from the Docker or
  Kubernetes template, or a cloud VM or sandbox from a custom recipe. See
  [Host recipes](hosts/recipes.md).

Managed sandbox providers (Fly Sprites, Daytona, E2B) have no built-in
support. A recipe can drive their CLIs.

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
- A host Manor starts from a [recipe](hosts/recipes.md) and reaches over a
  command (`docker exec`, `kubectl exec`) needs that CLI, signed in, instead
  of ssh.

## Adding a host and a remote project

1. **Add the host.** Open Settings → Hosts → **Add a host…** → **A machine I
   can SSH into** → **Continue** (or Project Settings → Host) and enter an ssh target: `user@box`, `box`
   (an alias from `~/.ssh/config`) or `ssh://user@box:2222`. To have Manor
   start the host instead, choose **Start a new host** (see
   [Host recipes](hosts/recipes.md)).
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
| `~/.manor/remote/server/` | The host server: its socket, owner token, pid, logs, its own relay keys and paired phones, and the box's projects (`projects.json`), layout (`layout.json`) and agents (`agents.json`) (see [The host server](#the-host-server)) |
| `~/.manor/remote/hook-port` | The hook listener's port and token (mode 0600) |
| `~/.manor/remote/control-port` | The CLI relay's port and token (mode 0600) |
| `~/.manor/remote/supervisor.json`, `supervisor.env` | What keeps Manor running across a reboot, and the variables it passes on (see [Surviving a reboot](#surviving-a-reboot)) |
| `~/.manor/remote/hooks/` | The box hooks `on-busy` and `on-idle` (see [Box hooks](hosts/recipes.md#box-hooks)) |
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
git, file reads and port scans all use that connection. A recipe host reached
over a command such as `docker exec` has no ControlMaster: each stream is its
own process. Recipes themselves live in `~/.manor/host-recipes/`, and a recipe
host reached over ssh has its own `~/.manor/ssh/known_hosts.d/<hostId>`.

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
  connects to the daemon on the box like any other client does, and it owns
  the box's side of Manor. That covers the projects, workspaces and layout;
  creating worktrees and running their setup scripts; starting agents and
  reading their status from the hook journal; the chat view; GitHub through
  the box's own `gh`; push notifications; the `manor` CLI on the box; and its
  own room on the Manor relay with its own paired phones.

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

When a supervisor keeps Manor running on the box, these starts, stops and
restarts go through it instead, and the daemon and the host server come back
after a reboot with no desktop. See [Surviving a reboot](#surviving-a-reboot).

**The owner channel.** The desktop talks to the host server over the box's
existing ssh connection: `ssh <box> manor-host server-bridge`, which pipes to
the server's socket at `~/.manor/remote/server/server.sock`. Being able to
run that command as you over ssh is the authentication, so the desktop is the
server's **owner** and may do what a phone may not: add and remove projects,
pair and revoke phones, and reset the server's keys. The desktop pushes
nothing to the server any more (it used to send a manifest and a layout
snapshot). It reads and writes the box's state through the server, and hears
changes as events. It keeps a cache of the last answers, so the sidebar still
shows the box's workspaces while it is away.

**Viewer streams.** Each desktop window also talks to the host server
directly, over a stream of its own: `ssh <box> 'exec manor-host server-bridge
--viewer'`, on the same ControlMaster as the owner channel. It authenticates
the same way (SSH, then the 0600 token file on the box) and its hello marks
it as a desktop window. The window's reads, writes and terminal bytes for the
box's projects go over it straight to the host server, one hop. Main only
moves frames between the window and ssh (the `hostPipe` preload namespace);
it doesn't parse or route them. A window opens a stream once the host is
connected and its server says it takes one (`viewer-bridge` in its status),
and main closes it when the window closes or the host drops.

- **Terminal size.** The host server ranks a desktop window's stream like a
  local window, above every phone, so the desktop still decides a pane's size
  while it has the pane mounted, and a phone follows. One registry on the box
  decides that for every viewer.
- **When a stream drops**, the window falls back to main for that host: main
  forwards its calls over the owner channel (`HostRouting`) and serves the
  cache while the host is away. The window dials the stream again with
  backoff, and at once when the host reconnects, then redraws its panes over
  it.
- **Main keeps the owner channel** for what needs one bridge: a phone paired
  only with the desktop (its terminals for the box are forwarded by main to
  the host server), the `manor` CLI and MCP routes, notifications and the
  dock badge, and the cache. The desktop's daemon connection to the box is
  for lifecycle only now: starting the daemon, upgrades, port forwards and
  the CLI relay. Remote panes are no longer attached over it.

### Older host servers

A host server from before multi-server support doesn't report
`viewer-bridge`, so a desktop window opens no stream to it. The window
reaches that box through main, as it did before: main forwards every call
over the owner channel, and attaches the box's terminals through the host
server. The same applies to a box that hasn't been adopted yet. The next
connect upgrades the host package, and the window opens its stream once the
new server reports `viewer-bridge`. Until its upgrade runs, an older server
also lacks `pty.reset` and `pty.close`.

### Adoption

The first time the desktop connects to a box whose server owns nothing yet, it
hands over what it holds for that host: the host's projects (with their
workspace names, folders, linked issues, hidden flags and settings), its
agents and its layout. This is **adoption**. The server merges the records by
id and wins every conflict, so adopting twice, or from a second laptop, adds
what the box lacks and overwrites nothing.

Only after the server has acknowledged does the desktop let go. It first
writes a backup of what it removed to
`~/.manor/backups/pre-adr-227-<hostId>.json` on your laptop, then drops the
projects from its `projects.json` (their place in the sidebar and in linked
groups is kept), drops the agents, and releases the layout. Sessions are not
touched: terminals and agents carry on where they were. If the desktop stops
part-way, the next connect finishes the job. You don't have to do anything,
and the sidebar looks the same afterwards.

Agents the desktop had recorded as active are checked against the box's
daemon right away: one whose terminal is gone is marked abandoned, rather
than waiting for the next boot sweep.

**Upgrading an old box.** A box whose host server predates this (no
ownership in its status) is left alone and keeps working as before. The
desktop reaches it with the older behavior until the box has a current host
server, which the next connect installs. See
[Legacy boxes](#legacy-boxes).

**Logs** are at `~/.manor/remote/server/logs/host-server.log` (rotated).
Startup failures, before that log is open, go to `host-server-spawn.log` in
the same directory. The first line of each start names the version and the
secret backend in use:

```
[host-server] 0.21.0 starting in /home/you/.manor/remote/server; secrets: systemd-creds
```

To restart it by hand, run `~/.manor/bin/manor-host restart-server` on the
box. It stops the server, through its supervisor when one runs it, and starts
it again, whether it runs under systemd, launchd or on its own. Unlike
`manor-host restart`, this doesn't touch the terminals.

## Surviving a reboot

**Keep Manor running when \<host\> restarts** (Settings → Hosts) puts the
box's daemon and host server under the box's own supervisor. After a reboot
they start again with no desktop: the host server rejoins its relay room, so
a phone sees the host and can start new agents with the lid closed.

- **On by default** for hosts added from now on, ssh boxes and recipe hosts
  alike. Hosts you added before stay off until you turn it on. The setting
  shows a line saying what keeps Manor running there, or why nothing does.
- Turning it on runs `manor-host supervisor install` on the box. It picks the
  first that works: systemd, launchd, then a container's `supervise`. If none
  does, it says "No supervisor on this host", and the switch stays off. Manor
  also installs it on connect when the switch is on and the box has none.
- **It doesn't move what's running.** The supervisor takes over the next
  time the daemon or the server restarts, or at the next boot. Turning the
  switch off removes the units and keeps `supervisor.env`, but stops nothing.
- **After a reboot** the daemon starts with no terminals. The host server
  marks the agents whose sessions are gone, as it does after a daemon
  restart, and a pane comes back (with its agent's resume command) when
  someone opens it. Agents aren't restarted by themselves.

**Linux with systemd.** Two user units in `~/.config/systemd/user/`,
`manor-host-daemon.service` and `manor-host-server.service`. Each runs the
`~/.manor/bin/manor-host` shim, so an upgrade takes effect at the next
restart, with `Restart=on-failure` and
`EnvironmentFile=-~/.manor/remote/supervisor.env`.

- A user's units only start at boot when the user **lingers**. `install`
  runs `loginctl enable-linger`, which polkit often refuses. Then the setting
  says "Starts after you log in to \<host\>. Run
  `sudo loginctl enable-linger <user>` there to start it at boot." Run that
  once on the box. (The user name in that hint comes from the ssh target, or
  `$USER`, which your shell on the box fills in.)
- `systemctl --user status manor-host-server` shows how it's doing.

**macOS with launchd.** Two LaunchAgents in `~/Library/LaunchAgents/`,
`sh.manor.host-daemon.plist` and `sh.manor.host-server.plist`, with
`RunAtLoad` and `KeepAlive`. A LaunchAgent starts at login, so a Mac with no
one logged in needs automatic login (System Settings → Users & Groups).

**Containers.** A container has no init system, so `manor-host supervise`
is its entrypoint (the reference image runs it; see
[The host image](hosts/recipes.md#the-host-image)). It starts the daemon and
the server, restarts either one when it exits (1 s backoff, doubling to
30 s), passes SIGTERM on, and adopts a daemon or server that is already
running instead of starting a second. Its pid is in
`~/.manor/remote/supervise.pid`, and it records itself in `supervisor.json`
when it starts, so the switch reads on from the first connect. After a node
reboot, the container's restart policy brings it back. The switch can't turn
it off: it is the container's entrypoint.

**`supervisor.env`** passes `MANOR_SECRET_KEY_FILE`, `MANOR_SECRET_KEY` and
`MANOR_INSTANCE_ID` to the units (see
[Encrypting pairing keys](#encrypting-pairing-keys)). `install` writes the
ones it finds in its own environment, and keeps the ones already in the
file. You can add them by hand, one `KEY='value'` line each. The host server
reads the file itself when it starts, supervised or not, so the same lines
reach an ssh box with no supervisor. A variable already in the environment
wins over the file. Turning the switch off keeps the file.

## Your phone with the lid closed

Pair a phone with the desktop from **Settings → Devices**, and it is
paired with every remote host that lets devices reach it (see
[One pairing for every host](#one-pairing-for-every-host)). Pairing a phone
with one box alone has no button in Settings any more (see
[Pairing a phone with a host](remote-control.md#pairing-a-phone-with-a-host)).
The phone reaches the box's host server directly, through the
Manor relay, whether or not your laptop is awake.

**One sidebar.** The phone connects to every pairing it holds at once and
shows their projects together, each under its host's name. A box's project is
answered by the box's own pairing while that is reachable, and through the
desktop otherwise. With the desktop away, the desktop's own projects stay
listed, dimmed, from what it last said, and writes to them are refused; a box
that is awake keeps working. The **Hosts** sheet (from the bottom of the
drawer) lists each pairing with its reachability, and renames or removes one.

**What it can do:**

- See the box's projects, workspaces and agents, with live status.
- Create a workspace (a worktree, with the project's setup script run on the
  box) and launch an agent in it with a prompt, from the New agent composer.
- Open any terminal and type into it.
- Use the chat view and reply, slash commands included.
- Rearrange the layout (split, close, move tabs); the box owns it.
- Get push notifications when an agent needs input or hits an error.
- Use Linear through the desktop while the desktop is awake, even on a box
  that doesn't have Linear (see
  [Linear through the desktop](#linear-through-the-desktop)).

**What it can't do:**

- Add or remove a project, or set one up on a box. That needs the desktop (it
  is an owner-only action). Until the box has been adopted, the server
  answers *This host is being set up* and the phone sees no projects.
- Use Linear with the desktop away, until you turn on **Use Linear on
  \<host\>** from the desktop (see [Integrations](#integrations)).
- Reach the desktop's own features: the box's server has no browser panes,
  windows or system integration.

If the box is away, or its server refuses something, the phone says so
(a toast naming the host and the reason) instead of failing quietly. A host
Manor put to sleep shows as **Asleep** in the Hosts sheet, with **Wake** while
the desktop is awake (see [Asleep hosts](#asleep-hosts)).

Some more details:

- **Layout.** The layout is the box's own, so a terminal an agent starts on
  the box is in it from the start. The old **Started while away** tab is
  gone.
- **Terminal size.** While the desktop has a terminal open, or another client
  is attached to it, the phone follows its size and shrinks the font rather
  than resizing it. When the phone is the only one attached, the terminal
  takes the phone's size.
- **Projects the desktop sets up while connected** are on the box at once.
  One set up on the box (by its `manor` CLI, say) shows on the phone and, the
  next time the desktop connects, on the laptop.
- **Issue and PR data** is live from the box's own `gh`; Linear is off until
  you turn it on for the host. See [Integrations](#integrations).

When the desktop goes to sleep, its projects on the phone read as away
(dimmed, writes refused) within about 15 s. The phone checks the line to the
desktop itself, because the relay keeps answering the phone's heartbeat for
a desktop that has gone silent.

When the laptop opens again, it doesn't replay anything: it reads the box's
state through the server, so the sidebar already shows what the phone did,
including a workspace made while away, its agent's tab and the agent's
status, with no restart.

### One pairing for every host

A phone paired with the desktop doesn't need a QR code per host. Every time
it connects to the desktop, it asks the desktop to pair it with each host it
doesn't already hold (`remoteControl.linkHostPairings`). For each host whose
server is connected and whose relay is up, the desktop pairs the phone there
over the owner channel, under the phone's own label, and hands the phone that
room's key and token inside the phone's own encrypted channel. A host added
later, or one that was away, is picked up on a later connect.

- **Revoking the phone on the desktop** revokes it on every host it was
  linked to. A host that is away then is revoked on its next connect.
- **Devices can reach \<host\>.** Each host's row on Settings → Hosts
  (under *Device access*) has this switch, on by default. Turning it off
  stops linking phones to that host and revokes the ones already linked.
- **Removing a host on the phone** (the Hosts sheet) is remembered: the
  desktop won't link that room again. The same goes for a pairing the host
  revoked. Pairing that host again by its QR code undoes it.
- **Reset pairing keys** on a host drops every phone there and moves the host
  to a new room. Phones still paired with the desktop are linked to the new
  room on their next connect.

## Where secrets live

The host server keeps a few secrets in `~/.manor/remote/server/`, each in its
own 0600 file:

| File | What |
|---|---|
| `relay-identity.enc` | The host server's relay identity: the keys that make its relay room its own, and the key phones check in the pairing QR |
| `remote-devices.enc` | Phones paired with this host. Device tokens are stored only as SHA-256 hashes |
| `remote-vapid.enc` | The Web Push signing key. The desktop sends its own, so one browser push subscription works for every host. A host uses a key of its own until the desktop's arrives |
| `secret-backend` | Which backend encrypted the files above |
| `instance.json` | The instance id the server was created under, when it has one (see [Host recipes](hosts/recipes.md#never-snapshot-a-host-that-has-run-manor)) |
| `owner-token` | The token the owner channel presents on the server's socket. New on every start |
| `~/.config/manor/secret.key` | Outside `~/.manor`: the key that seals the files above, when Manor made one (see [Encrypting pairing keys](#encrypting-pairing-keys)). Deleting it strands them |

Device tokens are hashed, so the secrets worth protecting are the relay
identity and the push key. Someone who already has your account on the box can
use them. That person can also reach your terminals, your repos and your
agents' own credentials, so the keys add little to that. Encryption protects
against the files leaving the box: a backup, a disk image, a volume snapshot.

If you suspect the box was compromised, use **Reset pairing keys** in that
host's row on Settings → Hosts. It gives the host server a new
relay identity, which moves it to a new room and disconnects every phone paired
with it. Pair them again afterwards.

### Encrypting pairing keys

The host server encrypts its keys with the first of these that works on the
box, checked on first start (and, while it is on plaintext, on every start):

1. **A key you supply** (`key-file`), whenever `MANOR_SECRET_KEY` or
   `MANOR_SECRET_KEY_FILE` is set in the server's environment. See
   [A key from outside the box](#a-key-from-outside-the-box). This is what
   hosts Manor starts from a template use. **Encrypt them** (below) makes
   one on an ssh box.
2. **`systemd-creds --user`** (systemd 256 or newer). It encrypts with a key
   derived from the machine's own credential secret, and uses the TPM2 chip
   when the machine has one. You can decrypt the files without root, but a
   copy of them is useless on any other machine.
3. **libsecret**, when an unlocked Secret Service keyring (GNOME Keyring,
   KWallet) is reachable over D-Bus and `secret-tool` is installed. Manor keeps
   one random key in the keyring and encrypts the files with it (AES-256-GCM).
   A server started over ssh usually has no D-Bus session, so on a headless
   box this rarely applies.
4. **Plaintext files, mode 0600**, as a last resort. This is never silent:
   the host's row on Settings → Hosts says *Pairing keys on
   \<host\> are stored unencrypted*.

**Encrypt them** is the one-click way off plaintext, on a connected ssh host
in Settings → Hosts. It works on the box in four steps:

1. It makes a 32-byte key at `~/.config/manor/secret.key` (or
   `$XDG_CONFIG_HOME/manor/secret.key`), mode 0600, in a 0700 directory. An
   existing valid key is reused. An invalid one is an error, and it is never
   overwritten. If `supervisor.env` already names a key file outside
   `~/.manor`, that key is checked and used instead, and nothing is made.
2. It names the key in `~/.manor/remote/supervisor.env` as
   `MANOR_SECRET_KEY_FILE`. A key that file named inside `~/.manor`, or a
   `MANOR_SECRET_KEY` written in it, is replaced: the keys are still
   plaintext, so nothing is sealed with it yet. The old key file is left
   where it is.
3. It restarts the host server. The new start seals the existing key files
   with the key, so phones stay paired.
4. It checks that the box now uses `key-file`.

Be clear about what this buys. A copy of `~/.manor`, such as a backup, an
rsync of the data directory or a snapshot of a volume mounted there, can no
longer read the pairing keys. A copy of the whole home directory or the disk
still can, because the key is on the same disk. If the restart fails, the key
and the `supervisor.env` line stay, and the box stays on plaintext. Click
**Encrypt them** again, or wait for the next start, and it finishes. The hint
beside the button names the key file the click will use.

**A recipe host** gets its key from its recipe, not from the button. The recipe
has to give the host `MANOR_SECRET_KEY_FILE` (the Docker and Kubernetes
templates already do; see [Host recipes](hosts/recipes.md#pairing-key-encryption)).
A host in a container gets its key from the container's environment.

**To check which backend a box uses:**

- Look for the warning on the host's row on Settings → Hosts. No warning means the keys
  are encrypted.
- On the box, run `~/.manor/bin/manor-host secrets status --json`. It prints
  `{"secrets":{"backend","keyFile","place"}}` and changes nothing. `backend` is
  `key-file`, `systemd-creds`, `libsecret` or `plaintext`.
- Or read the `secrets:` field on the startup line of
  `~/.manor/remote/server/logs/host-server.log`.

**To find out whether systemd-creds would work**, run this on the box:

```bash
systemd-creds --version | head -1        # needs 256 or newer
echo probe | systemd-creds --user encrypt --name=manor - - >/dev/null && echo ok
```

**The choice is remembered.** Once a backend other than plaintext has
encrypted the keys, the host server keeps using it. If it later stops working,
the server reports an error naming it, and doesn't fall back to writing
plaintext or start over with new keys. Setting `MANOR_SECRET_KEY` later
doesn't move a box off systemd-creds or libsecret. A box on `key-file` stays
there too: a later systemd 256 doesn't move it to systemd-creds.

**Keep the key file.** Deleting `~/.config/manor/secret.key`, or whatever file
`supervisor.env` names, strands the pairing keys. The server can't open them,
and it won't start over with new ones. The recovery is **Reset pairing keys**
in that host's row on Settings → Hosts. It gives the host new keys, and the
phones paired with it have to pair again.

**Plaintext upgrades itself.** Plaintext is only ever a last resort, so a host
server on plaintext checks for a key, then systemd-creds, then libsecret every
time it starts. When one works, it encrypts the existing key files with it and
switches to it. Your phones stay paired. A key that is named but can't be used
(a missing or invalid key file) doesn't stop a server that is still on
plaintext: it logs a warning to `host-server.log`, tries the next backend, and
stays on plaintext if none works. So to move a box off plaintext,
make one of them work (for example, upgrade systemd to 256 or newer), then
restart the host server:

```bash
~/.manor/bin/manor-host restart-server
```

Check that the warning on the host's row in Settings → Hosts is gone, or that
`manor-host secrets status --json` names the new backend.

### A key from outside the box

The `key-file` backend seals the files with AES-256-GCM under a 32-byte key
you supply, so a copy of the box's disk, volume or snapshot holds nothing
usable without the key. It reads the key from one of:

- **`MANOR_SECRET_KEY`**: the key, base64 encoded;
- **`MANOR_SECRET_KEY_FILE`**: a file holding the key, as 32 raw bytes or
  base64 text. Typically a mounted Kubernetes Secret or Docker secret.

`MANOR_SECRET_KEY` wins when both are set. A key that is set but isn't 32
bytes, or a file that can't be read, is an error: the server doesn't fall
back to a weaker backend. The one exception is a server still on plaintext,
which warns and stays there (see *Plaintext upgrades itself* above).

The host server keeps the key to itself. It takes the variables out of its
own environment when it starts, so the terminal daemon, every shell and agent
on the box, and the busy hooks never see them.

To make one: `head -c 32 /dev/urandom | base64`.

**The host server must have the variable every time it starts:**

- in a container, from the container's environment (the Docker and
  Kubernetes templates set `MANOR_SECRET_KEY_FILE=/run/secrets/manor-key`
  and mount the key there);
- on an ssh box, from `~/.manor/remote/supervisor.env` (see
  [Surviving a reboot](#surviving-a-reboot)). The host server reads that file
  itself when it starts, supervised or not. A variable already in its
  environment wins over the file.

A server that sealed its keys with `key-file` and then starts without the
key stops with "Pairing keys were sealed with a key from MANOR_SECRET_KEY or
MANOR_SECRET_KEY_FILE, and neither is set". It never starts over with a new identity: give it the key again.

**Keep the key off the box's disk.** A `MANOR_SECRET_KEY_FILE` under
`~/.manor` is on the volume it is meant to protect. The host server notices,
and the host's row on Settings → Hosts says *The key sealing pairing keys is
kept inside ~/.manor on \<host\>, beside what it protects.* A `MANOR_SECRET_KEY`
written into `supervisor.env` is on that disk too, and the host server warns
about it the same way: prefer a mounted file.

A key file in your home but outside `~/.manor`, such as the one **Encrypt
them** makes, gets a quieter note on the row: the keys are encrypted with a
key kept at that path, which protects them from a copy of `~/.manor` but not
from a copy of the whole disk.

## Integrations

Every integration is one of two kinds:

- **Host-native**: the credential is already on the box because your agents
  use it, such as `gh` and git. The host server runs these with the box's own
  sign-in, in the checkout, and nothing gets copied. If `gh` isn't signed in on
  the box, Manor says so ("gh isn't signed in on \<host\>") rather than
  failing. PR badges for a remote workspace come from the box's `gh`, and a
  workspace row shows a small warning icon in place of the badge while `gh`
  isn't signed in there. Three things still use your laptop's `gh`: showing a
  private-repo image from a PR or issue, creating an issue, and listing the
  repos you can pick from.
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

### Linear through the desktop

A phone that reaches a box without Linear can still use Linear, through the
desktop. Linear calls aren't tied to a box, so each one goes to whichever
server has Linear:

1. the box's own server, if you turned on **Use Linear on \<host\>**;
2. else the desktop that lists the box, if it is awake and has Linear
   connected. The key never leaves the desktop;
3. else nowhere, and the phone says why, naming the desktop as its pairing
   does: for example "Linear isn't turned on for wsl-box, and my-laptop is
   away".

Browsing issues with no box in mind (the Tasks view) asks the desktop first,
then any box with Linear on. When none has it, the Tasks view names the
reason ("Linear isn't connected on This Mac, and no host has it turned on").
Linking an issue to a workspace is still the box's own: the link is stored
with the project on the box, whichever server answered the browse. On the
desktop nothing changes: its own server is always there and holds the key.

### Linear without a key on the box

If you don't want the key on the box, skip the switch and use Linear's MCP
server in the agent instead. It needs nothing from Manor: add the Linear MCP
server to the agent's own configuration on the box and sign in there. The
trade-off is that Manor doesn't see those issues, so there is no issue link on
the workspace and no "start work from an issue" flow.

## Laptop closed

- **Agents keep running.** They run on the box, not the laptop.
- **Status is decided on the box.** An agent's hooks (started, working,
  finished, needs permission) go to a loopback listener run by the remote
  daemon. The daemon appends each one to
  `~/.manor/remote/daemon/hook-journal.ndjson`, and the host server reads
  that journal and keeps the agent's status. The journal keeps at most
  5,000 entries, and none older than 7 days.
- **While you're away**, the host's projects show a *disconnected —
  reconnecting* badge. The sidebar keeps the box's last-known workspaces and
  agents, and its panes keep their last screen, read-only, under a banner.
  Manor retries with backoff (1s, 2s, 4s, and so on, up to every 30s) for as
  long as the app is open. **Retry now** skips the wait.
- **When the connection is back**, Manor reads the box's state through its
  server (nothing is replayed) and reattaches the panes from their
  snapshots. Whatever happened while you were away, including a phone's work,
  is already there. Notifications are coalesced: after a night away you get
  at most one per agent, for its final state.
- **If the box rebooted, or the daemon was restarted**, the daemon's
  terminals are gone, but files and agent session ids survive. Manor treats
  each lost pane as it does on an app relaunch: a fresh shell in the same
  directory, and for a pane that had an agent, that agent's resume command
  (for example `claude --resume <id>`). A notice says *Remote host restarted
  — N sessions resumed*.

A box that stops (a VM that was shut down, a machine that powered off) takes
running agents down with it, and they resume only when you reconnect. With
[supervision](#surviving-a-reboot) on, its daemon and host server come back
by themselves when the box boots again.

### Asleep hosts

A host Manor starts from a recipe can be put to sleep: **Stop** on Settings →
Hosts, the box's own [`on-idle` hook](hosts/recipes.md#box-hooks), the
recipe's `idleStopMinutes`, or the provider itself. An asleep host shows as
**Asleep** (a moon) in the status bar, the sidebar and the Hosts page, and
its workspaces are listed from the cache, read-only, as for any host away.

- **Manor doesn't wake it by itself.** Reconnecting after the lid opens,
  pollers and **Retry now** leave it asleep. Its recipe's `status` is asked
  before each reconnect attempt, so a host the provider put to sleep is
  noticed too.
- **A reconnect re-runs `up` once.** When a recipe host that isn't asleep
  drops, Manor redials the way in the last `up` returned. Before the third
  attempt it runs the recipe's `up` again, once per drop, in case the box
  came back somewhere else (a new address, container or pod). Its progress
  shows in the host's status while it reconnects. A failing `up` is logged
  and the redial goes on. A recipe with no `status` whose `up` said
  `autoSleep` is never re-run this way, because that could wake a box that
  put itself to sleep.
- **Using it wakes it.** **Wake** in the host's status does, and so does
  anything that means to use the host: opening one of its panes, creating a
  workspace, launching an agent. Reads never do. The call waits up to two
  minutes for the host to come up, then answers "\<host\> is still starting"
  while it goes on starting.
- **Restoring the window you had open when Manor starts doesn't wake it.**
  The panes of the workspace on screen at launch show the asleep banner
  instead; **Wake** there brings the host up and the panes reattach.
  Opening another of its workspaces, or a new pane or tab, is using it and
  wakes it.
- **Idle stop counts every viewer.** A recipe's `idleStopMinutes` stops a
  host only when nobody is looking at it: no desktop window, no phone
  paired with the host, and no phone or window going through the desktop
  has one of its terminals open, and no phone has one of its agents' chats
  open. A phone left open on a terminal keeps the box up. A host server
  older than ADR-230 reports desktop windows only, so phones don't count
  there until its next upgrade.
- **On a phone**, the Hosts sheet shows the host as **Asleep** with
  **Wake**, which asks the desktop to start it. With the desktop away it
  says "\<host\> is asleep, and \<desktop\> is away": nothing on the relay
  can start a stopped box.

## The `manor` CLI

Agents on the box can run the `manor` CLI to look up their project, manage
workspaces and folders, link issues, and list and launch agents. The CLI is
installed at `~/.manor/bin/manor` and is on PATH in every remote PTY.

Requests go to a loopback listener run by the remote daemon. The listener
passes each one to the box's host server, which answers it the way the desktop
would for a local project. The result comes back the same way. Your laptop
isn't involved, so the CLI works with the lid closed, and a workspace made
with it shows on a phone paired with the box straight away.

If the host server isn't running, CLI commands fail with "Manor's host server
isn't running on this host". Before the box's first adoption, the server
answers "This host is being set up" until the desktop has connected once.
There is no queueing or journal for CLI requests, unlike hooks.

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
A route that only exists in the desktop app (the webview, panes, browser and
system routes) says "needs Manor desktop; it isn't available from remote
hosts".

The other direction works too: the desktop's own CLI and MCP, run on your
laptop, act on a remote project through its host server. If a box runs an
older host server (without the control relay), those writes fail with a 502
or 503 until the box is upgraded.

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

A host Manor starts with an exec way in (the Docker and Kubernetes
templates) has no sshd to forward through. Manor listens on a local port
itself and carries each connection over the exec stream to `port-pipe` on
the box. These forwards carry half-close both ways: a client that shuts its
write side after its request (HTTP/1.0-style clients, `nc -N`, some database
drivers) still gets the reply. Once one side has finished, the other has 5
minutes of silence before the connection is closed.

## Legacy boxes

A box that has no current host server running (it failed to start, or its
upgrade failed, so it still has one from before ADR-227) no longer gets the
desktop's help. The desktop stopped replaying its journal, polling its agent
status, chat and worktrees, and caching its workspaces itself, because the
host server does those now. On such a box you'll see:

- no agent status, chat view or worktree list updates in the sidebar;
- no last-known workspaces while the box is away;
- removing a project while its box is away only tears down the main path's
  layout;
- the desktop's CLI and MCP writes for its projects fail until the box is
  upgraded (a 502 or 503).

**The fix is to upgrade the box.** Connect the desktop to it: the next connect
installs the matching host package and starts a current host server, and
adoption does the rest. Nothing on the box needs to be done by hand.

## What isn't supported

- **Built-in managed providers** (Fly Sprites, Daytona, E2B, Codespaces).
  Use a [recipe](hosts/recipes.md) that drives their CLI.
- **Waking a stopped host from the phone while the desktop is away.** The
  relay holds no provider credentials.
- **Resuming agents by themselves after a reboot.** Their panes come back
  when opened, with the agent's resume command.
- **Windows hosts.** Linux and macOS only.
- **Remote MCP.** Agents on the box don't get Manor's MCP server. Hooks
  work, and the `manor` CLI works for the commands listed in "The `manor` CLI"
  section.
- **Open in editor**, and the directory picker, for remote paths. There's no
  file sync to a local editor either. Use your editor's own remote mode (VS
  Code Remote-SSH, Zed remote) against the same box.
- **One box per project.** A project's workspaces all live on its host.
- **Moving a project off an adopted host** ends its panes there and loses its
  remembered path, since the box's layout goes with the project. A transfer
  onto an adopted host doesn't carry the source's main-workspace name or
  issue links.
- **Detached windows** of a remote workspace keep their viewport on the
  desktop; a phone's view of the box's layout is its own.
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

Each failure mode below is shown on the host (status bar and Settings → Hosts)
with the message quoted here.

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

**"Device access needs the host to reconnect"** (Settings → Hosts → the host)
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

**"Pairing keys were sealed with a key from MANOR_SECRET_KEY or MANOR_SECRET_KEY_FILE, and neither is set"**
The host server sealed its keys with a key you supplied, and started without
it (see [A key from outside the box](#a-key-from-outside-the-box)). Give it
`MANOR_SECRET_KEY` or `MANOR_SECRET_KEY_FILE` again, the same key, and
restart it.

**"The host server restarted but its pairing keys are still plaintext"** (Encrypt them)
The key file and the `supervisor.env` line are in place, and the server
restarted, but it still didn't pick the key up. Read
`~/.manor/remote/server/logs/host-server.log` on the box for the reason: look
for `could not move pairing keys to key-file`. Then click **Encrypt them**
again. It reuses the key, and the next start finishes.

**"No supervisor on this host"**
"Keep Manor running" found neither a systemd user manager, launchd, nor a
running `manor-host supervise`. On a container, use an image whose entrypoint
runs `manor-host supervise` (see
[The host image](hosts/recipes.md#the-host-image)).

**"Starts after you log in to \<host\>"**
systemd runs the units, but the user doesn't linger, so they start only at
login. Run `sudo loginctl enable-linger <user>` on the box once.

**"\<host\> no longer exists"**
The recipe's `status` says the box was deleted outside Manor. **Start it
again** runs `up`, which creates a new one; **Remove…** forgets it.

**"\<host\> is still starting"**
A woken host took longer than two minutes. Its recipe's `up` goes on (up to
15 minutes), with its progress in the host's status. Try again once it's
connected.

**A recipe command fails**
The message names the command and quotes the end of what it printed on
stderr. "printed nothing on stdout" or "must print exactly one JSON object"
means the script wrote something other than its one JSON result to stdout.
See [Host recipes](hosts/recipes.md#how-a-command-runs).

**A phone paired with a host can't connect**
On the host's row on Settings → Hosts, check that the summary
says *relay connected*. The host server dials the Manor relay from the box, so
the box needs outbound HTTPS to `relay.manor.sh`.

To look under the hood on the box, the remote daemon's log is at
`~/.manor/remote/daemon/terminal-host.log`, and the host server's is at
`~/.manor/remote/server/logs/host-server.log`. `~/.manor/bin/manor-host
restart` stops the daemon (and its terminals), but not the host server; use
`~/.manor/bin/manor-host restart-server` for that.
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

# Hosts Manor starts (ADR-229): no sshd. Builds docker/host-image as
# manor-host:e2e and runs the recipe-host suite against the Docker daemon.
# Skipped, with a message, when Docker isn't available.
node scripts/test-remote-e2e.mjs --recipe

# The Kubernetes template on a real cluster (ADR-231): a kind cluster on the
# Docker daemon. Needs Docker, like --recipe, and is skipped, with a message,
# without it. Builds manor-host:e2e, creates the cluster and loads the image.
sg docker -c 'node scripts/test-remote-e2e.mjs --k8s'
```

`--k8s` uses `kind` and `kubectl` from `PATH` when they are there. Otherwise
it downloads pinned versions into `~/.cache/manor-e2e/bin/` and checks each
against a SHA-256 written in the script. Nothing is installed system-wide.
The cluster is a kind cluster named `manor-e2e` with its own kubeconfig in a
temp dir, so `~/.kube/config` is never read or written. It is deleted at the
end; set `MANOR_E2E_K8S_KEEP=1` to keep the cluster and the namespace for a
look after a failure. On a machine where Docker needs a group, run it with `sg docker -c
'…'`, as above.

- `electron/terminal-host/__tests__/remote-ssh.e2e.test.ts` (vitest) covers
  the bridge: cold bootstrap, reinstall over a stale version, session
  lifecycle, hook journal replay across a dropped connection, snapshot
  resync without duplicated output, and a remote daemon restart.
- `tests/e2e/remote-host.spec.ts` (Playwright) covers the app: laptop-closed
  replay with a single notification (the stub lingers 1.5 s in a shell
  running a script, and the test re-reads "thinking" 2 s after first seeing
  it), pane recovery with the agent's resume
  command after a remote restart, and port forwarding. Each test starts from
  a clean box.
- `electron/backend/__tests__/recipe-docker.e2e.test.ts` (vitest, `--recipe`)
  covers hosts Manor starts. It writes a recipe from the `docker` template
  and drives the desktop's `BackendRegistry`, `HostServerClient` and
  `HostRouting` against the container it starts:
  - `up` over `docker exec`, bootstrap, the host server under `supervise`,
    adoption, a workspace and an agent that reports status;
  - the `on-busy` box hook running when the agent works;
  - a port forward over exec (`port-pipe`);
  - a forced drop: the box's `server-bridge` and `remote-bridge` are
    killed, and the owner channel and the host reconnect by themselves to
    the same host server;
  - a forced drop after the box moved (ADR-230 D2): the container is
    renamed and the recipe's `up` and `status` now name the new one, so the
    old `docker exec` target fails. The reconnect re-runs `up` and finds the
    same host server under the new name, with no connect from outside;
  - a port forward that carries half-close (ADR-230 D4): a client that
    shuts its write side after its request still gets the reply;
  - `docker restart` with the desktop gone: the host server comes back by
    itself in the same relay room, sealed by `key-file` with the key off the
    volume, and an agent launched afterwards starts;
  - **Stop**: the host stays asleep for 10 s with no reconnect, then a
    routed write (create a workspace) wakes it and succeeds;
  - a second container on a copy of the volume, with another
    `MANOR_INSTANCE_ID`: a new relay room, its projects kept;
  - remove with destroy: the container, volume and recipe are gone, and the
    host is no longer listed.

  It removes every container and volume it makes, and keeps the image. Run
  as a user in the `docker` group (or with `sg docker -c '…'`). Set
  `MANOR_E2E_RECIPE_KEEP=1` to keep the container for a look after a
  failure. The host server's relay is a closed local port, as in the ssh
  suites, so no relay connection is tested there.
- `electron/backend/__tests__/recipe-kubernetes.e2e.test.ts` (vitest,
  `--k8s`) covers the `kubernetes` template on a kind cluster, with the same
  desktop side as the Docker suite (`recipe-e2e-harness.ts`), reached over
  `kubectl exec`:
  - `up`, bootstrap over `kubectl exec -i`, the host server under
    `supervise`, adoption, a workspace and an agent;
  - the `on-busy` box hook, a port forward over exec, half-close through it
    and a forced drop of the box's bridges;
  - the pod deleted (`kubectl delete pod`): with the desktop connected it
    reconnects without going `sleeping`, and with the desktop gone the host
    server comes back by itself in the same relay room;
  - **Stop** scales to 0 and the host stays asleep for 10 s, then a routed
    write wakes it;
  - remove with destroy: the StatefulSet, the claim and the Secret are gone.

  It leaves clone detection and the moved box to the Docker suite. It sets
  `MANOR_E2E_K8S=1` itself through `--k8s`.
- `tests/e2e/lid-closed.spec.ts` (Playwright) covers a real sleep (ADR-231
  D4). It freezes the app's process tree with `SIGSTOP` (ssh aside) and cuts
  its network. While the app is frozen, the box's agent works and a phone
  paired with the desktop and linked to the box watches and answers it. Then
  the app thaws with no Retry. The phone must read the desktop as away within
  30 s of the freeze. After the thaw the host reads `connected` and the final
  status is `responded`, with one notification for the absence and each
  ticker line written meanwhile exactly once. It doesn't fake `powerMonitor`'s
  `resume` event or push delivery.
- `tests/e2e/recipe-host.spec.ts` (Playwright) checks the recipe host helper
  (`helpers/recipe-host.ts`): a custom recipe whose `up.sh` returns an ssh
  way in to the harness's sshd, with no `status` script.
- `tests/e2e/host-restore-asleep.spec.ts` (Playwright) covers ADR-230 D3 on a
  recipe host. After the host is stopped and the app relaunched on the same
  home, the host stays asleep for 10 s and `up` doesn't run again. **Wake**
  runs it once and the pane reattaches. Opening another workspace of that
  host wakes it.
- `tests/e2e/host-idle-stop.spec.ts` (Playwright) covers ADR-230 D1 on a
  recipe host with `idleStopMinutes: 1`. A phone paired with the host keeps a
  pane open and no desktop window views it: the host stays connected for
  150 s and `stop` doesn't run. When the phone closes, the host sleeps. It
  uses the product's real timers and takes about 4 minutes, so leave it out
  of a quick run with `-- --grep-invert "idle stop"`. It is skipped in
  `--docker`, where the container can't reach the local relay on loopback.
- `tests/e2e/phone-drop-grace.spec.ts` (Playwright) covers ADR-230 D5: a
  phone behind the latency proxy. After `dropAll()` the relay is reachable at
  once and the unreachable overlay never shows. After `outage()` it shows
  within 4 to 8 s, and a call made meanwhile settles instead of hanging.
  After `restore()` it goes.
- `tests/e2e/host-server.spec.ts` (Playwright) covers the host server with the
  laptop gone. The desktop clones a project onto the box and starts an agent
  there, and pairs a browser with the box's host server through a local relay
  (`wrangler dev`). Then the desktop loses the box, and the browser alone
  checks that the project is in its sidebar, the agent is listed with its
  status, a hook fired on the box changes that status, and typing into the
  agent's pane reaches it. When the desktop reconnects, its agent state must
  match the host server's.
- `tests/e2e/host-ownership.spec.ts` (Playwright) covers the ownership flip.
  A desktop is launched holding a remote project (named workspaces, a folder,
  a linked issue, a setup script) in its own `projects.json`. It connects, and
  the spec asserts adoption: the box's `projects.json` has it all, the
  desktop's doesn't, the backup file exists, and the sidebar still shows it.
  Then the desktop's ssh is killed and a phone paired with the host server
  makes a worktree and launches an agent in it from the New agent composer.
  The setup script runs on the box, the agent goes from thinking to working to
  requires-input, the box's `manor list-workspaces` lists the new worktree, and
  a PR badge for it (from the box's fake `gh`) shows on the phone's tab menu.
  When the desktop reconnects, the workspace, its agent tab and the agent
  appear without a restart, with the badge.
  Same requirements as `host-server.spec.ts`.
- `tests/e2e/host-direct-bridge.spec.ts` (Playwright) covers a desktop
  window's own bridge to the host server (ADR-228 D4, D5). A pane on the box
  is typed into and resized over the window's `server-bridge --viewer`
  stream. When that stream is killed, typing and output still go through
  main, which forwards the pane's terminal to the box's server, and the
  window dials the stream again and redraws the pane over it.
  A host server that does not report `viewer-bridge` (the test-only
  `MANOR_E2E_HOST_CAPABILITIES` in `~/.manor-e2e/env` stands in for an older
  one) gets no stream, and its pane works through main. A browser paired
  only with the desktop (over a local relay, as in `host-server.spec.ts`)
  types into the box's pane and sees its output, through main. Each test
  starts from a clean box.
- `tests/e2e/phone-all-pairings.spec.ts` (Playwright) covers a phone holding
  every pairing at once (ADR-228 D8). One browser opens the desktop's link and
  the box's host server's, and its sidebar lists the desktop's project and
  the box's. With the desktop stopped, the box's project stays live (a branch
  made on the box afterwards is listed, and a `git checkout -b` there
  reaches the phone's sidebar through the box's own branch watcher, ADR-230
  D6), a write to the desktop's project is refused as away, and the
  desktop's project is still listed. Removing the desktop's pairing in the
  Hosts sheet takes its project out and leaves the box's.
- `tests/e2e/phone-linked-hosts.spec.ts` (Playwright) covers one pairing for
  every host (ADR-228 D9). A browser opens only the desktop's link, is linked
  to the box's room on its first hello, lists the box's project once (under
  the box's room) and shows on the box's device list "via This Mac". With the
  desktop stopped it keeps reaching the box. It also covers Linear through
  the desktop (D10): with Linear connected on the desktop only (main's
  Linear API is a stub there), the phone's Linear call is answered by the
  desktop, and with the desktop stopped it is refused as away. A call on
  behalf of one box is covered by unit tests
  (`src/bridge/__tests__/router.test.ts`), not end to end.

The Playwright specs share one box, so the harness runs them with one worker.
The box's host server dials `MANOR_RELAY_URL` from its environment, and the
harness sets that to a closed local port, so a test box never dials the
production relay. `host-server.spec.ts`, `host-ownership.spec.ts` and the
phone specs point it at their own relay through `~/.manor-e2e/env` on the box, which the harness's
ssh wrapper sources. The same file puts `~/.manor-e2e/bin` first on the
server's `PATH`, so the box's `gh` is a fake (`installRemoteStubs`; its
answers are set with `setRemoteGhPrs`).

**On this kind of machine.**

- The runner needs a display for the Electron app: run it as
  `DISPLAY=:0 node scripts/test-remote-e2e.mjs --playwright-only` (WSL2 with
  WSLg, for example; if `/tmp/.X11-unix/X0` is missing, link it from
  `/mnt/wslg/.X11-unix/X0`).
- The stub agent (`tests/e2e/remote-host/manor-e2e-agent`) ends with
  `exec awk`, not a shell loop. `--linger-ms N` sleeps between its last hook
  and the `exec`, to keep a shell running a script in the foreground.
- The specs that pair a browser over a local relay (`host-server`,
  `host-ownership`, the browser test in `host-direct-bridge`, and the two
  phone specs) serve the web app from the relay build: run
  `pnpm build:web:relay` first.
- Pass Playwright arguments after `--`, for example
  `-- --grep "host owns"`.
- `--docker` builds its image with plain `docker build`, so it needs no
  buildx plugin. Its sessions source `~/.manor-e2e/env` through a
  `ForceCommand` wrapper, and a spec that needs the local relay reaches it
  from the box over an `ssh -R` (`reachRelayFromBox`).

**Known local e2e failures.** These fail on `main` too, for reasons unrelated
to the host server, and are not regressions:

| Spec | Test | Why |
|---|---|---|
| `read-state.spec.ts` | "switching back to the agent's tab stops its tab dot pulsing"; "…workspace stops its sidebar dot pulsing" | They assert `app.dock.getBadge()`, which is macOS-only |
| `pr-badge-matrix.spec.ts` | "every PR badge state" (`g-queued-mergequeue readiness` expects queued, gets ready) | Fails on a clean `main` |
| `sidebar-pr-tweaks.spec.ts` | "sidebar PR badge, popover, notifications, folders and diff tree" | Fails on a clean `main` |
| `bridge.spec.ts` | "two desktop windows on one pane" (presses `Meta+t`); "the CLI lands with every window closed" | Non-macOS quits on the last window close, which removes the port file |
| `smoke.spec.ts` | "reopening a closed pane reattaches the same shell" | Fails on a clean `main` |
| `web-app.spec.ts` | "a PC browser pairs, sees the sidebar, and drives a live terminal…"; "the desk's window closes and the browser is told the winsize is its own"; "the browser arranges the desk's layout, the desk follows, and back" | Fail on the ADR-228 branch before the phone held every pairing (`a3058ed1`) too; not caused by it, not yet looked into |
| `host-direct-bridge.spec.ts` (`--docker`) | "a host server without viewer-bridge works through main" | Times out waiting for the host's first status. Fails on the ADR-229 base (`4b73fd9b`) too; passes on the private sshd |

The "laptop closed" test used to be flaky on both. A shell running a script
read as "the agent's process exited" (ADR-231 D5), and that is fixed: it
passed 10 of 10 on the private sshd and 4 of 4 in `--docker`.

**Flaky unit tests.** Under a full parallel `pnpm test:unit` these have
failed and then passed when run alone:
`electron/terminal-host/__tests__/bridge-process.test.ts` ("keeps its daemon
apart"), `exec-runner.test.ts` ("escalates to SIGKILL"),
`terminal-host.test.ts` ("new client can attach…") and `TaskDetail`.

The harness writes an ssh config with two aliases, `manor-e2e` (the app's)
and `manor-e2e-direct` (the tests' side channel), and passes it to the tests
as `MANOR_E2E_SSH_CONFIG`. Manor's managed ssh config includes that file
ahead of `~/.ssh/config`. This is a **test-only** hook
(`electron/terminal-host/ssh-config.ts`) and is unset in normal use. To use
a box of your own instead, write such a file yourself and set
`MANOR_E2E_SSH=1` and `MANOR_E2E_SSH_CONFIG`. Use a throwaway account: the
suites delete `~/.manor` there.
