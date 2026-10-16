# Host recipes

A **recipe** is a set of your own commands that start, stop and delete one
host. Manor runs them on your computer. They can start a cloud VM, a sandbox,
a Kubernetes pod or a local Docker container, and Manor doesn't need to know
that provider's API. Once the host is up, Manor treats it like any other
remote host: it installs its host package there, and the host gets its own
host server, relay room and phone access (see
[Remote hosts](../remote-hosts.md)).

Design background is in
[ADR-229](../decisions/adr-229-hosts-we-start/index.md).

## Starting a host

Open **Settings → Hosts**, then **Add a host… → Start a new host**. Pick one of:

- **Docker container**: a container on this computer's Docker daemon, or
  on another machine's over SSH. The quickest way to try it. See
  [Docker](#docker).
- **Kubernetes cluster**: a pod with its own disk, on a cluster you can reach. See
  [Kubernetes](#kubernetes).
- **Custom recipe**: anything else, for example a cloud VM with sshd. Manor
  writes a recipe folder with an `up.sh` for you to finish. See
  [A custom recipe for a cloud VM](#a-custom-recipe-for-a-cloud-vm).

Manor writes the recipe into `~/.manor/host-recipes/<id>/`, then runs its
`up`. Its progress shows in the host's status. After `up`, the host is set up
as an ssh box is: the first connect installs Manor's host package, which on
Linux compiles `node-pty` (see [Requirements](../remote-hosts.md#requirements)).

Each host on the Hosts page offers what its recipe allows:

- **Stop**, when the recipe has a `stop`. The host then shows as **Asleep**.
- **Wake** (from the host's status), for a host that is asleep.
- **Start it again**, for a host whose `status` says it no longer exists.
- **Keep Manor running when \<host\> restarts**. On by default for recipe
  hosts (see
  [Surviving a reboot](../remote-hosts.md#surviving-a-reboot)).
- **Remove…**: **Remove from Manor**, or **Destroy host and its disk** when
  the recipe has a `destroy` (see [stop and destroy](#stop-and-destroy)).

## The contract

### Files

A recipe lives in `~/.manor/host-recipes/<id>/`, next to its scripts:

```json
{
  "schemaVersion": 1,
  "id": "k8s-dev",
  "name": "Dev pod",
  "template": "kubernetes",
  "up": "./up.sh",
  "status": "./status.sh",
  "stop": "./stop.sh",
  "destroy": "./destroy.sh",
  "idleStopMinutes": 30,
  "env": { "NAMESPACE": "manor", "IMAGE": "ghcr.io/me/manor-host:22" }
}
```

| Key | What |
|---|---|
| `schemaVersion` | Always `1` |
| `id` | The folder's name. Letters, digits, `.`, `_` and `-` |
| `name` | How Manor names the host |
| `template` | The template it was made from, if any. Informational |
| `up` | **Required.** Starts the host and says how to reach it |
| `status` | Optional. Says whether the host is up, asleep or gone |
| `stop` | Optional. Puts the host to sleep. Turns on **Stop** |
| `destroy` | Optional. Deletes the host and its disk. Turns on **Destroy** |
| `idleStopMinutes` | Optional. Stop the host after this long idle, while this computer is awake (see [Box hooks](#box-hooks)) |
| `env` | Optional. Non-secret settings, added to every command's environment |

- **Never read from a repository.** Cloning a repo must not be able to run
  code on your computer, so Manor only reads recipes from
  `~/.manor/host-recipes/`.
- **Strict.** An unknown key is an error, not a setting that is silently
  ignored. A relative command must stay inside the recipe's folder.
- **One recipe, one host.** A recipe that already starts a host can't start
  a second one.
- **Secrets don't go in `env`.** Use your own environment, or your provider
  CLI's sign-in.
- **`host.json`** in the folder is Manor's own record: what the last `up`
  returned as `resource`, and whether the host was last put to sleep. Your
  scripts may keep their own state in the folder (the templates don't need
  to).

### How a command runs

- On this computer, with the recipe's folder as its working directory.
- The file is run directly, so it needs a `#!` line and the executable bit.
- **Environment:** yours, plus the recipe's `env`, plus:
  - `MANOR_HOST_ID`: the host's id in Manor;
  - `MANOR_RECIPE_DIR`: the recipe's folder;
  - `MANOR_INSTANCE_ID`: see [`MANOR_INSTANCE_ID`](#manor_instance_id).
- **Stdin:** `{"hostId": "…", "resource": …}`. `resource` is what the last
  `up` returned, or `null`.
- **Stdout is one JSON object and nothing else**, for every command,
  including `stop` and `destroy` (which print `{}`). At most 64 KB. A stray
  `echo` is an error, and Manor quotes it.
- **Stderr is progress.** Each line shows in the host's status while `up`
  runs. When a command fails, the message quotes the last 2 KB.
- **Named stages (optional).** A stderr line `manor-stage: <text>` sets the
  host's status to `<text>`, such as `manor-stage: Getting a disk`. Once
  `up` has printed one, its other lines no longer replace the stage in the
  status (they still go to the output, stage lines included); a later
  `manor-stage:` line replaces it. Each run of `up` starts without a stage.
  A recipe that prints none shows every line, as above.
- **A non-zero exit is a failure.**
- **Timeouts:**

  | Command | Timeout |
  |---|---|
  | `up` | 15 minutes |
  | `status`, `stop` | 2 minutes |
  | `destroy` | 10 minutes |

  When a command runs out of time, Manor kills its whole process group
  (SIGTERM, then SIGKILL 3 s later), so the script's own children go too.

The templates keep stdout clean with one line at the top, and print their
result on fd 3:

```bash
#!/usr/bin/env bash
set -euo pipefail
exec 3>&1 1>&2   # fd 3 is the real stdout; everything else goes to stderr

# … start the box …

echo '{"schemaVersion": 1, "connection": {"type": "exec", "argv": ["docker", "exec", "-i", "my-box"]}}' >&3
```

### `up`

`up` must be **idempotent**. It creates the host if it's missing, starts it
if it's stopped, and prints how to reach it either way. Manor runs it before
every connect: adding the host, Manor's own background connect (unless the
host is asleep), **Wake**, **Start it again**. It doesn't run it again when a
connection drops and is retried: the retry uses the way in the last `up`
returned, so a host that came back at a new address is found again only on
the next full connect.

Over ssh:

```json
{
  "schemaVersion": 1,
  "resource": { "id": "srv-4711" },
  "connection": {
    "type": "ssh",
    "target": {
      "host": "203.0.113.7",
      "port": 22,
      "username": "dev",
      "identityFile": "~/.ssh/id_ed25519",
      "hostKey": "ssh-ed25519 AAAA…"
    }
  },
  "autoSleep": false
}
```

Over a command that runs one command on the host (for a host with no sshd):

```json
{
  "schemaVersion": 1,
  "resource": { "container": "my-box" },
  "connection": { "type": "exec", "argv": ["docker", "exec", "-i", "my-box"] }
}
```

| Key | What |
|---|---|
| `schemaVersion` | Always `1` |
| `resource` | Optional. Anything. Handed back on every command's stdin |
| `connection.type` | `"ssh"` or `"exec"` |
| `connection.target` | ssh: `host`, `port` and `username` are required. `identityFile`, `identitiesOnly`, `hostKey`, and one of `jumpHost` (`[user@]host[:port]`, comma-separated) or `proxyCommand` are optional |
| `connection.argv` | exec: the command prefix |
| `autoSleep` | Optional. `true` when the provider puts the host to sleep by itself when it's idle |

- **Unknown keys are refused**, and so is a target with both `jumpHost` and
  `proxyCommand`.
- **Over ssh**, Manor writes the target into its own ssh config as
  `Host manor-<hostId>`. Your `~/.ssh/config` isn't changed, and ssh runs
  with `BatchMode yes` as for any host (see
  [Requirements](../remote-hosts.md#requirements)).
- **Over exec**, Manor appends `sh -c '<command>'` to `argv` for each stream.
  `kubectl exec` needs a `--` before the command; `docker exec` doesn't.
  There is no ControlMaster, so each stream (daemon, host server, each
  window, each forwarded connection) is its own process. Port forwards go
  through `manor-host port-pipe` on the host.
- **The host needs** `sh`, Node.js 20 or newer, git, and on Linux the build
  toolchain for `node-pty`, as an ssh box does.

### `status`

Optional. It prints one of:

```json
{ "state": "up" }
{ "state": "sleeping" }
{ "state": "missing" }
{ "state": "error", "detail": "the pod is not ready" }
```

- `sleeping`: the host shows as **Asleep**. Manor doesn't reconnect to it
  until something means to use it (see
  [Asleep hosts](../remote-hosts.md#asleep-hosts)).
- `missing`: the host was deleted outside Manor. It shows "\<name\> no longer
  exists", with **Start it again** (which runs `up`) and **Remove**.
- `error`: shown with its `detail`.

Manor asks before each reconnect attempt and before a background connect.
Without a `status`, the state is what Manor last did: up after `up`, asleep
after `stop`, and once connected, how the connection is doing.

### `stop` and `destroy`

- **`stop`** puts the host to sleep. Manor drops its connection first, then
  runs `stop`, and the host shows as **Asleep** until something wakes it.
  `up` must be able to start it again with its disk.
- **`destroy`** deletes the host and its disk. It runs from **Remove… →
  Destroy host and its disk**, which lists the projects that live only on
  that host and asks for the host's name to be typed. If `destroy` fails,
  nothing is removed. If it succeeds, Manor forgets the host and deletes the
  recipe's folder. There is no undo: the host owns its projects' workspace
  names, folders and linked issues. Branches you pushed survive.
- **Remove from Manor** (without destroy) leaves the host running. Manor
  forgets the host and drops its record of the last `resource`. So adding a
  host from the same recipe again runs `up` with no `resource`: a recipe
  that finds its host by a fixed name (both templates do) gets the same one
  back, while one that relies on `resource` may create a second host and
  leave the first running. Delete it yourself, or destroy before removing.

### Host keys

A recipe host reached over ssh has its own `known_hosts` file,
`~/.manor/ssh/known_hosts.d/<hostId>`. Its key is stored under the alias
`manor-<hostId>`, so a host that comes back at a new address keeps it.
Nothing else in your `known_hosts` is read or written.

- **When `up` returns `hostKey`**, Manor writes it there, replacing any older
  key, and checks strictly against it.
- **Without one**, the first connect accepts the host's key into that file
  (`accept-new`), and checks strictly after that.
- **A changed key is refused** as a connection failure, unless the same `up`
  returned the new key. A re-created VM really has a new key, and only the
  recipe can vouch for it. Return `hostKey` if your provider can tell you
  the key (some print it to the console log, or let you set it through
  cloud-init).

### `MANOR_INSTANCE_ID`

Every command gets `MANOR_INSTANCE_ID`: the last `resource` if it is a
string, its `id` if it is an object with one, otherwise the host's id. Pass
an id that names this one host into the host's environment as
`MANOR_INSTANCE_ID`. The host server stores the id it was created under, and
a different one on a later start means its data was copied (see
[Never snapshot a host that has run Manor](#never-snapshot-a-host-that-has-run-manor)).

The Docker template passes the container's name. The Kubernetes template
passes `<namespace>/<name>`.

### Pairing key encryption

A recipe host on plaintext pairing keys is fixed in its recipe, not with
**Encrypt them**. The recipe has to give the host a key: set
`MANOR_SECRET_KEY_FILE` to a file holding a 32-byte key, where the host server
reads it. The Docker and Kubernetes templates already do: they mount a key at
`/run/secrets/manor-key` and set `MANOR_SECRET_KEY_FILE` in the container's
environment. For a custom recipe on a VM, the usual way is to make the key file
and write the line `MANOR_SECRET_KEY_FILE='<path>'` to
`~/.manor/remote/supervisor.env` through cloud-init (see
[Encrypting pairing keys](../remote-hosts.md#encrypting-pairing-keys)).

Settings → Hosts doesn't offer **Encrypt them** for a recipe host. The recipe
owns the host's setup, so the fix belongs there. A recipe host still on
plaintext shows the warning with a link to this section.

## The templates

The templates are ordinary recipes once written. Their scripts are yours to
edit. Each generated script says so at the top.

### The host image

Both templates run Manor's host image, `ghcr.io/orrybaram/manor-host:<version>`
(the version of your Manor app; published by each release): Node 22, git, gh,
the `node-pty` toolchain, tini, and a `manor` user (uid 1000, home
`/home/manor`). Nothing of Manor's is baked in. The entrypoint waits for the
first connect to install `~/.manor/bin/manor-host` on the home volume, then
runs `manor-host supervise`. The image has no agent CLIs.
Both templates ask "Agents to install" (Claude Code, on by default, and
Codex), recorded as `MANOR_AGENTS=claude,codex` in `recipe.json`. After the
container or pod is up, `up.sh` installs each one that is missing as the
`manor` user onto the home volume (`npm i -g --prefix ~/.local`, printing
`manor-stage: Installing Claude Code`); `~/.local/bin` is on the image's
`PATH`. It runs once and survives restarts and image upgrades. A failed
install is a warning on stderr, not a failed `up`. Leave both unchecked to
install none, or edit `MANOR_AGENTS` in the recipe.

You do not need to build anything: the Docker template's `up.sh` pulls the
image when the daemon does not have it (printing `manor-stage: Getting
Manor's host image`), and a cluster's nodes pull it themselves. To customise
it, build it from `docker/host-image` (the app ships that folder as
`host-image/` in its resources), then give your own image name in the form:

```bash
docker build -t manor-host:local docker/host-image
```

For a cluster, push it somewhere the cluster can pull from.

### Docker

The form asks for:

- **Run it on**: *This computer* (the default) or *Another machine over
  SSH*;
- **SSH target**, for another machine only: `you@build-box`,
  `you@build-box:2222`, or a `Host` from your `~/.ssh/config`;
- **Container name** (also the recipe's id, `docker-<name>`);
- **Image** (default `ghcr.io/orrybaram/manor-host:<version>`; an image the daemon already has is not pulled);
- **Docker context** (optional, such as `colima` or `desktop-linux`; blank
  for the default). A remote daemon works too.

The recipe's context (`MANOR_DOCKER_CONTEXT`) is, in order: the Docker
context field when you fill it in; for another machine, `manor-<host>`
(the target's host, lowercased, anything but letters, digits and `-`
turned into `-`); otherwise none, which is Docker's current context.

#### Docker on another machine over SSH

If all you want is Manor on another machine, **Add a host… → A machine I
can SSH into** is simpler: Manor installs itself there directly. Use this
when you want a container there that Manor starts, stops and can throw
away.

Docker on your computer talks to the machine's Docker over ssh, through a
Docker context. Before Start, the checklist checks, in order:

1. the target answers over SSH (`ssh -o BatchMode=yes -o ConnectTimeout=5`,
   with your `~/.ssh/config`). Manor can't answer a host-key or passphrase
   prompt: if the machine's key isn't trusted yet, run `ssh <target>` once
   in a terminal and accept it; for a passphrase, `ssh-add` your key;
2. Docker is installed on the machine;
3. you can use it there. If Docker refuses you (permission denied on
   `docker.sock`), run `sudo usermod -aG docker $USER` on the machine, then
   log out of it and back in;
4. Docker is installed on this computer (only the CLI is needed);
5. Docker on the machine is set up for Manor. **Set up Docker on
   *host*** runs `docker context create manor-<host> --docker
   host=ssh://<target>`. An existing `manor-<host>` that already points
   there is reused; one pointing somewhere else is yours, so Manor leaves
   it alone and asks you to pick a context under Advanced or remove it;
6. Manor can reach Docker through that context, and the host image is on
   the machine. The image is pulled there, for the machine's own CPU; the
   build fallback builds there too (`docker --context manor-<host> build`
   sends the build files over ssh).

If you remove the context later, `up` makes it again before any other
docker call (`manor-stage: Setting up Docker on <host>`), from the target
the recipe records in `MANOR_DOCKER_SSH_TARGET`. That applies only to the
context Manor derived (`MANOR_DOCKER_CONTEXT_MANAGED=1`), not to one you
chose under Advanced. A context of that name that points somewhere else is
left alone and `up` fails with a one-line reason. The ssh check above is
reused for 15 seconds while the form refreshes, and only when it passed.

`up`:

- creates the volume `manor-<name>-home` and mounts it on `/home/manor`;
- creates the volume `manor-<name>-key` and, once, fills it with
  `secret.key` (32 random bytes, readable only by uid 1000) using the host
  image itself. It is mounted read-only at `/run/secrets/manor`, with
  `MANOR_SECRET_KEY_FILE` pointing at the file (see
  [Encrypting pairing keys](../remote-hosts.md#encrypting-pairing-keys));
- sets `MANOR_INSTANCE_ID` to the container's name;
- runs the container with `--restart unless-stopped`, or starts it if it
  exists and is stopped. Pulling the image, creating the container and
  starting it are named stages (`manor-stage:`);
- writes no-op `on-busy` and `on-idle` hooks if there are none (see
  [Box hooks](#box-hooks));
- returns `docker exec -i -u manor <name>` as the way in.

`status` reads `docker inspect`. `stop` runs `docker stop` and keeps the
container and its volumes. `destroy` removes the container, the home volume
and the key volume.

The key lives on the daemon, in a volume apart from the home volume, so a
copy of the home cannot read it. Nothing is bind-mounted from your computer,
so remote Docker contexts, colima and Rancher Desktop work.

### Kubernetes

The form asks for:

- **Cluster** (required): kubectl's saved login for the cluster to run the
  host on, listed from your kubeconfig with each cluster's server. The
  form starts on the cluster your most recent Kubernetes recipe used, if
  it is still listed, and otherwise on none; it never picks kubectl's
  current context for you;
- **Size**: what the pod reserves and how far its memory may grow. Small
  (¼ CPU, 512 MiB, up to 2 GiB), Medium (½ CPU, 1 GiB, up to 4 GiB, the
  default) or Large (1 CPU, 2 GiB, up to 8 GiB). Agents sit near idle and
  burst while building, so requests are low and several hosts share a node;
- **Namespace** (default `manor`; created if missing);
- **Name**;
- **Image** (default `ghcr.io/orrybaram/manor-host:<version>`; the cluster must be able to pull it);
- **Disk size** (default `20Gi`) and **Storage class** (optional).

`up`:

- creates the Secret `<name>-key` with 32 random bytes, once, and mounts it
  at `/run/secrets/manor-key`;
- applies a StatefulSet of one replica with a volume claim `home` on `/home/manor`, `MANOR_SECRET_KEY_FILE` and
  `MANOR_INSTANCE_ID=<namespace>/<name>`. The pod passes Pod Security
  "restricted": it runs as non-root uid/gid 1000 (`fsGroup` 1000) with the
  `RuntimeDefault` seccomp profile, no privilege escalation and all
  capabilities dropped. The size becomes `MANOR_K8S_CPU`,
  `MANOR_K8S_MEMORY` and `MANOR_K8S_MEMORY_LIMIT`: the pod requests the
  first two, and its memory is limited to the third (to the request in a
  recipe without it). There is no CPU limit, so a build isn't throttled;
- scales it to 1 and waits for the pod to be Ready, every 3 seconds,
  naming the stage it is at: "Getting a disk" (the claim `home-<name>-0`
  isn't bound), "Finding room on the cluster" (the pod isn't scheduled),
  "Downloading the image on the node" (the container is being created),
  then "Starting". It stops at once, printing the cluster's own reason, when
  the pod can't start: the claim still Pending after 60 seconds with a
  `ProvisioningFailed` or `FailedBinding` event (no storage class, or one
  that doesn't work); the pod unscheduled after 60 seconds with a
  `FailedScheduling` event (no node has room); the pod refused (a
  `FailedCreate` event, such as a policy or quota); the container waiting on
  `ErrImagePull`, `ImagePullBackOff`, `InvalidImageName` or
  `CreateContainerConfigError`; or killed `OOMKilled`. It gives up 14
  minutes after `up` started, naming the stage it was stuck at, a minute
  before Manor's own timeout;
- writes no-op hooks if there are none;
- returns `kubectl [--context …] -n <namespace> exec -i <name>-0 -c host --`
  as the way in.

Every command passes `--context` when the recipe has `MANOR_K8S_CONTEXT`.
Recipes made before the cluster was required, or before sizes, keep working:
without a context kubectl uses its current one, and without
`MANOR_K8S_CPU` / `MANOR_K8S_MEMORY` the pod has no `resources` block.

`stop` scales the StatefulSet to 0 and keeps the claim and the Secret.
`destroy` deletes the StatefulSet, the claim `home-<name>-0` and the Secret.

`kubectl exec` streams can be cut by the API server's idle timeouts. Manor
reconnects them with backoff, as it does for a dropped ssh connection.

`status` says `sleeping` only for 0 replicas. While a pod is deleted, evicted,
rescheduled or still starting, it says `up` with the detail "the pod is not
ready yet", so Manor keeps redialling instead of marking the host asleep.

The template is run against a real cluster by
`node scripts/test-remote-e2e.mjs --k8s` (see
[Testing](../remote-hosts.md#testing)). It passed on kind v0.33.0, with the
node image Kubernetes v1.37.0 and kubectl v1.37.1. kind is a conformant
cluster, but it isn't a managed one. A cloud cluster's storage classes
(kind's local-path ignores `fsGroup`), admission policies such as Pod
Security `restricted`, and exec timeouts can still differ. The suite leaves
clone detection and a moved box to the Docker suite.

## A custom recipe for a cloud VM

**Add a host… → Start a new host → Custom recipe** asks for a name, then writes a
folder with `recipe.json` and an `up.sh` that fails until you finish it.
**Show folder** opens it. When `up.sh` is ready, click **Start host**.

This example uses Hetzner Cloud's `hcloud` CLI. Use your own provider's CLI
the same way. The VM must allow your ssh key, and have Node.js 20 or newer,
git, and `python3`, `make` and `g++` (cloud-init can install them).

`recipe.json`:

```json
{
  "schemaVersion": 1,
  "id": "build-vm",
  "name": "Build VM",
  "up": "./up.sh",
  "status": "./status.sh",
  "stop": "./stop.sh",
  "destroy": "./destroy.sh",
  "env": { "SERVER": "manor-build-vm", "SSH_KEY": "laptop" }
}
```

`up.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
exec 3>&1 1>&2

state=$(hcloud server describe "$SERVER" -o format='{{.Status}}' 2>/dev/null || true)
case "$state" in
  "")
    echo "Creating $SERVER"
    hcloud server create --name "$SERVER" --type cx22 --image ubuntu-24.04 \
      --ssh-key "$SSH_KEY" --user-data-from-file ./cloud-init.yaml
    ;;
  off)
    echo "Starting $SERVER"
    hcloud server poweron "$SERVER"
    ;;
esac

ip=$(hcloud server describe "$SERVER" -o format='{{.PublicNet.IPv4.IP}}')
id=$(hcloud server describe "$SERVER" -o format='{{.ID}}')
printf '{"schemaVersion":1,"resource":{"id":"%s"},"connection":{"type":"ssh","target":{"host":"%s","port":22,"username":"root","identityFile":"~/.ssh/id_ed25519"}}}\n' \
  "$id" "$ip" >&3
```

`status.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
exec 3>&1 1>&2

state=$(hcloud server describe "$SERVER" -o format='{{.Status}}' 2>/dev/null || true)
case "$state" in
  "") echo '{"state":"missing"}' >&3 ;;
  running) echo '{"state":"up"}' >&3 ;;
  off) echo '{"state":"sleeping"}' >&3 ;;
  *) printf '{"state":"error","detail":"the server is %s"}\n' "$state" >&3 ;;
esac
```

`stop.sh` and `destroy.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
exec 3>&1 1>&2
hcloud server shutdown "$SERVER"   # destroy.sh: hcloud server delete "$SERVER"
echo '{}' >&3
```

- The first connect takes the VM's host key. If the VM is deleted and created
  again, its new key is refused until `up` returns it as `hostKey`.
- `resource.id` becomes the commands' `MANOR_INSTANCE_ID`. The host server
  reads `~/.manor/remote/supervisor.env` when it starts, so cloud-init can
  write a line `MANOR_INSTANCE_ID='<id>'` there. Without it, the host server
  under systemd uses `/etc/machine-id`, which a VM made from a snapshot may
  share.
- A VM that keeps running costs money while you're away. Add a box hook that
  powers it off when it has been idle (below).

## Box hooks

The host server decides when its host is **busy**: when any agent there is
thinking, working or waiting for input. It runs a hook on the host each time
that changes:

- `~/.manor/remote/hooks/on-busy`, as soon as an agent turns active;
- `~/.manor/remote/hooks/on-idle`, once every agent has been quiet for 60
  seconds.

Each must be an executable file. It runs with `MANOR_BUSY=1` or `0` in its
environment, and is killed after 30 seconds. Its output goes to
`~/.manor/remote/server/logs/hooks.log`. The hooks are how a host keeps
itself awake, or lets itself sleep, while your laptop is closed: Manor knows
no provider here. The templates write no-op hooks for you to edit.

A hook that wants to wait longer than 30 seconds starts a background job and
exits. This pair powers a VM off after 30 idle minutes:

`on-idle`:

```bash
#!/bin/sh
# Power off after 30 minutes with no agent working; on-busy cancels it.
pidfile="$HOME/.manor/remote/hooks/idle-stop.pid"
nohup sh -c 'sleep 1800 && sudo poweroff' >/dev/null 2>&1 &
echo $! > "$pidfile"
```

`on-busy`:

```bash
#!/bin/sh
pidfile="$HOME/.manor/remote/hooks/idle-stop.pid"
[ -f "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null
rm -f "$pidfile"
exit 0
```

A container can't usually stop itself this way (the Docker template's
`--restart unless-stopped` starts it again); call your provider's API from
the hook instead.

**`idleStopMinutes`** is the desktop's version of the same thing. While this
computer is awake, Manor stops a host whose server has been idle that long,
as long as nobody has one of its terminals open: no desktop window, and no
phone, whether paired with the host or going through the desktop. A phone
with one of its agents' chats open counts too. It never stops a busy host.
With the lid closed, only a hook (or a provider's own `autoSleep`) can. For a
recipe with `idleStopMinutes` and neither, the Hosts page says "Stops after
30 min idle only while This Mac is awake".

## Never snapshot a host that has run Manor

The host server keeps its relay identity in `~/.manor/remote/server/`. Two
hosts started from one snapshot, image or copied volume of that directory
would share one relay room, and each one's phones would see the other's
agents.

- **Build images before Manor first connects.** The reference image has
  nothing of Manor's in it; the first connect installs it on the volume.
- **Give every host its own `MANOR_INSTANCE_ID`.** The host server records
  the id it was created under. When it starts under a different one, it
  keeps the projects, agents and layout, and resets everything sealed: the
  relay identity (so it gets a new room), paired phones and push
  subscriptions, its push key, and its Linear token. It logs
  `cloned data dir: identity reset`, and Settings → Remote control says why
  phones need pairing again. Phones paired with your desktop are linked to
  the new room on their next connect.
- Without `MANOR_INSTANCE_ID`, the host server uses `/etc/machine-id` when
  systemd supervises it, or the Mac's hardware UUID under launchd.
  Otherwise nothing detects a copy. Containers often share or regenerate
  their machine id, so it isn't used there.
