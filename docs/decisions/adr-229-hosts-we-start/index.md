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

# ADR-229: Hosts we start ourselves

Slice 4 of ADR-225, and its last.
- Slice 1 (ADR-225, ADR-226) put a **Host server** on every remote host.
- Slice 2 (ADR-227) made it the authority for its host.
- Slice 3 (ADR-228) let one renderer talk to every server, and gave the
  phone one list for all its hosts.

Every one of those hosts is still a box the user brought, already running,
and reachable over SSH. This slice lets Manor start the host itself, and
keeps a host's Manor running after the host reboots.

## Context

### What ADR-225 asked of this slice

ADR-225 "Slices after this one", item 3:
- Pods, sandboxes and VMs through `HostProvider`, with ADR-178 §1's
  `ensureUp`, `status` and `setBusy`.
- Or an Orca-style recipe that provisions anything and returns SSH details.
- Each one runs the same tarball, so it brings a host server with it.
- Supervision that survives a reboot (systemd user unit, LaunchAgent).

ADR-225 also deferred these to slice 4:
- **D1.** "Surviving a reboot is out of scope here, because the daemon does
  not survive one either." `docs/remote-hosts.md` says the same thing about
  the host server.
- **D6.** "Hosts we start ourselves (slice 4) take secrets from a mounted
  Secret or an environment variable, never from the persistent volume."

ADR-178 deferred two more:
- **§1.** The **keep-awake rule**. It was "defined now and exercised by the
  first managed provider".
- **Out of scope.** Managed providers, each "its own ticket or ADR against
  `HostProvider`".

ADR-227 and ADR-228 defer nothing to this slice by name. ADR-228's Scope only
lists "Hosts we start ourselves (slice 4)". Their known limits (branch
watching on the phone, shared viewers on main, older host servers, and so on)
are about routing, not about starting hosts. They stay open and are not
pulled in here. See Scope.

### Where the code is

- **The seam was trimmed.** ADR-178 §1 named `ensureUp`, `status`,
  `setBusy` and `capabilities`. What landed in
  `electron/backend/providers/types.ts` is `kind: "ssh"`, `transport()`,
  `forwardPort`, `openServerChannel`, `openViewerChannel` and `dispose`.
  Nothing calls a lifecycle method, because nothing has one.
- **`HostSpec` is `{ kind: "ssh"; target: string }`**
  (`electron/backend/types.ts:277`, mirrored in `src/store/host-store.ts:6`).
  `createProvider` (`providers/index.ts`) has one case.
- **The transport is SSH all the way down.** `SshTransport`
  (`electron/terminal-host/transport-ssh.ts`) runs every bridge (daemon,
  owner, viewer) and every bootstrap snippet as an `ssh -T` child on a
  ControlMaster. The parts that aren't SSH-specific are already separate:
  - `HostTransport` (`transport.ts`) asks only for `Duplex` streams. Its
    comment already expects "a provider SDK's exec stream".
  - Bootstrap runs through an injected `RemoteExec`
    (`backend/remote-bootstrap.ts`).
  - The bridge child plumbing (`spawnBridgeChild`, `awaitHelloLine`) is one
    function each.
- **Hosts are added and never removed.** `hosts.add(target)` exists
  (`electron/bridge/handlers/hosts.ts:43`), reached from
  `ProjectHostSection`. There is no `hosts.remove` and no hosts page. The
  registry has `unregister`, but nothing calls it from the UI.
- **Lifecycle is "spawn detached on connect".**
  - `remote-bridge` runs `LocalTransport.ensureRunning()` (namespace
    `remote`), which spawns the daemon detached.
  - `server-bridge` runs `ensureServerRunning()` (`host-server/lifecycle.ts`),
    which spawns `manor-host serve` detached. On a version mismatch it kills
    the old server and spawns the new one.
  - After a reboot, nothing runs until the desktop connects again. With the
    lid closed, the host's relay room stays dark.
- **Secrets.** `pickHostSecretBox` (`electron/platform/secret-box.ts`) tries
  systemd-creds, then libsecret, then plaintext. A container has neither
  of the first two, so a pod today stores its relay identity in plaintext on
  its volume.
- **Who knows a host is busy.** The host server is the authority for its
  agents (ADR-227 D2). It already runs the reconciler, whose
  `ACTIVE_STATUSES` are `thinking`, `working` and `requires_input`
  (`electron/agent-status/reconciler.ts:124`). ADR-178 §1's rule puts the
  busy decision in the desktop's registry, which can't see anything while
  the lid is closed.

### What Orca does

Orca (stablyai/orca, `skill-guides/orca-per-workspace-env`) has
**environment recipes**:
- They are declared in the repo's `orca.yaml` as `create`, `suspend`,
  `resume` and `destroy` scripts.
- The scripts run on the desktop. Stdout is reserved for one JSON result, and
  progress goes to stderr.
- The lifecycle payload is passed on stdin.
- In SSH mode, `create` prints
  `{schemaVersion:1, connection:{type:"ssh", projectRoot, target:{label, host, port, username, identityFile?, jumpHost? | proxyCommand?}}}`.
  The schema is strict, and it refuses `jumpHost` and `proxyCommand`
  together.

Three of their lessons apply here directly:
- **Never snapshot a machine the runtime has run on.** Two VMs booted from
  one such image had the same pairing identity and device tokens.
- **Don't trust an unverified host key** from a recipe.
- **Stdout is for the result only.** One stray `echo` corrupts it.

Orca's recipes are per *workspace*, and they are read from the repo. Manor's
unit is the *host*: ADR-178 has one box per project, and one box per
workspace is out of scope there. Manor also never runs code from a repo it
merely cloned.

## Decision

### D1. `HostProvider` gets its lifecycle

`electron/backend/providers/types.ts` gains the methods ADR-178 §1 named,
plus `stop` and `destroy`:

```ts
type ProviderState = "up" | "starting" | "sleeping" | "unreachable" | "error";

interface HostProvider {
  readonly kind: "ssh" | "recipe";
  readonly capabilities: {
    canStop: boolean;        // stop() puts it to sleep; ensureUp() wakes it
    canDestroy: boolean;     // destroy() deletes the box and its disk
    autoSleep: boolean;      // the provider sleeps it on its own when idle
  };
  ensureUp(onProgress?: (line: string) => void): Promise<void>;
  status(): Promise<{ state: ProviderState; detail?: string }>;
  setBusy?(busy: boolean): void;
  stop?(): Promise<void>;
  destroy?(): Promise<void>;
  // transport(), forwardPort, openServerChannel, openViewerChannel, dispose as today
}
```

- **SSH boxes don't change.**
  - `ensureUp` is a no-op.
  - `status` is `up`, or `unreachable` after a failed connect.
  - All three capabilities are false.
- **Connecting calls `ensureUp` first.** `RemoteHostConnection.connect`
  awaits `provider.ensureUp(onProgress)` before the backend connects. Its
  progress lines go to `HostStatusInfo.progress`, as bootstrap's do.
- **A sleeping host is a state, not an error.**
  - `HostStatus` gains `"sleeping"`.
  - Before each reconnect attempt, the backoff loop asks `provider.status()`.
    On `sleeping`, the host goes to `sleeping` and **the loop stops**.
  - Background pollers (`autoConnect`) don't wake it either.
  - Otherwise a desktop reconnecting after the lid opens would wake every
    host the user had put to sleep.
- **Waking takes intent.** A host wakes when one of these happens:
  - a new owner method, `hosts.wake(hostId)`;
  - a renderer call routed to that host that would otherwise answer
    `unavailable:host-away` (opening a pane, creating a workspace, launching
    an agent). The router (ADR-228 D1) and `HostRouting` both call
    `hosts.wake` first for a host whose status is `sleeping`.
- **New `hosts.stop(hostId)`.** It calls `provider.stop()` and marks the host
  `sleeping`. It is only offered when `capabilities.canStop`.
- **`hosts.list` gains** `providerKind` and `capabilities`, so the renderer
  can offer Wake, Stop and Destroy only where they work.

### D2. The recipe provider: anything that returns a way in

`HostSpec` gains `{ kind: "recipe"; recipeId: string }`. A **recipe** is a
set of commands the user owns. They run on the desktop and start, stop and
delete one host. This covers VMs, cloud sandboxes, pods and local containers
without Manor knowing any provider's API.

- **Where recipes live.** In
  `~/.manor/host-recipes/<recipeId>/recipe.json`, next to their scripts.
  - They are never read from a repository. Cloning a repo must not be able to
    run code on the laptop. This is a deliberate difference from Orca's
    `orca.yaml`.
  - A recipe and a host are one-to-one. The recipe's state file
    (`state.json`, written by the scripts) belongs to that host.

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

  - Only `up` is required.
  - `stop` makes `canStop` true, and `destroy` makes `canDestroy` true.
  - `env` holds non-secret parameters (D8 template forms write it). Secrets
    come from the user's own environment or the provider CLI's sign-in, as
    in Orca.
- **How a command is run.**
  - It runs with the recipe directory as cwd.
  - The environment is the user's, plus `env`, plus `MANOR_HOST_ID`,
    `MANOR_RECIPE_DIR` and `MANOR_INSTANCE_ID` (D6).
  - It gets `{hostId, resource}` on stdin, where `resource` is whatever the
    last `up` returned.
  - **Stdout is one JSON object and nothing else.** Stderr lines stream as
    progress.
  - Timeouts: `up` 15 minutes, `stop` and `status` 2 minutes, `destroy`
    10 minutes. On a timeout, the whole process group is killed.
- **`up` is idempotent.** It creates the host if it's missing, resumes it if
  it's stopped, and returns a way in either way:

  ```json
  {
    "schemaVersion": 1,
    "resource": { "any": "opaque value handed back on stdin" },
    "connection": {
      "type": "ssh",
      "target": { "host": "203.0.113.7", "port": 22, "username": "dev",
                  "identityFile": "~/.ssh/id_ed25519",
                  "hostKey": "ssh-ed25519 AAAA…" }
    },
    "autoSleep": false
  }
  ```

  or `"connection": { "type": "exec", "argv": ["kubectl", "exec", "-i", "-n", "manor", "manor-host-0", "-c", "host", "--"] }`
  (D3).
  - Validation is strict, as in Orca. Unknown keys are refused, and
    `jumpHost` with `proxyCommand` is refused.
  - A failure becomes a `HostFailure` that quotes the stderr tail.
- **`status` is optional.** It prints `{"state": "up" | "sleeping" | "missing" | "error", "detail"?}`.
  - Without a `status` command, the state comes from the last
    `up`/`stop`/connect.
  - `missing` (the box was deleted outside Manor) shows the host as
    "\<name\> no longer exists" with **Start it again** (`up`) and **Remove**.
- **Host keys.**
  - An SSH connection gets its own `known_hosts` file,
    `~/.manor/ssh/known_hosts.d/<hostId>`. Manor's managed ssh config points
    `UserKnownHostsFile` at it for that host only, with
    `StrictHostKeyChecking yes`.
  - When `up` returns `hostKey`, it is written there.
  - Without one, the first connect uses `accept-new` into that file.
  - After that, a changed key is refused as a `HostFailure`, unless the same
    `up` returned the new key. A re-provisioned VM legitimately has a new
    key, and only the recipe can vouch for it.
- **The SSH target** is written into Manor's managed ssh config as a
  per-host `Host manor-<hostId>` stanza. `SshTransport` uses that alias, so
  ControlMaster, port forwards and `ssh-config.ts` work unchanged.
- **After `up`**, the host bootstraps exactly as an SSH box does:
  `remoteHostEnsurer` installs the version-pinned tarball, and
  `remote-bridge` and `server-bridge` start the daemon and the host server.
  That is "each one runs the same tarball".

Rejected: **one built-in provider per vendor** (Sprites, Daytona, E2B,
Kubernetes) in this slice. Each vendor's API is a moving target, and each
would need its own credentials UI. A recipe is one contract, and the D8
templates cover the common shapes. A first-class vendor provider can still be
added later as another `kind`.

Rejected: **recipes per workspace**, as Orca does. ADR-178 has one box per
project, and the host server's authority (ADR-227) is per host.

### D3. An exec transport for hosts with no sshd

Pods and containers usually have no sshd. A recipe can return
`connection.type: "exec"`: an argv prefix that runs one command on the host
with stdio attached, such as `kubectl exec -i … --` or `docker exec -i <name>`.

- **`CommandTransport`** (`electron/terminal-host/transport-command.ts`)
  implements `HostTransport`, plus the `exec`, `openServerBridge` and
  `openViewerBridge` that `SshTransport` has. It builds each child as
  `[...argv, "sh", "-c", snippet]`.
- **One bridge implementation.** `SshTransport`'s child spawning, hello
  reading and exit-error handling move into a shared `BridgeSpawner` that
  takes a "build the child argv" function. SSH supplies
  `ssh -T -F <cfg> <alias> <cmd>`, and exec supplies the prefix. The daemon,
  owner and viewer streams are then the same code on both.
- **No ControlMaster.** Every stream is its own child. That costs a process
  per stream (three per host, plus one per window). It is fine for
  `kubectl`/`docker`, which are designed to be called this way.
- **Port forwards over exec.** There is a new `manor-host port-pipe <port>`
  mode that pipes stdio to `127.0.0.1:<port>` (or `[::1]`) on the host.
  - `CommandHostProvider.forwardPort` listens on a local loopback port and
    runs one `port-pipe` child per accepted connection.
  - Webviews, portless and preview URLs (ADR-178 §5) work unchanged.
- **The box needs `sh` and Node ≥ 20**, as bootstrap already requires.

Rejected: **`kubectl port-forward` and the Kubernetes API directly.** That
would tie the transport to one orchestrator. `port-pipe` works for any exec
prefix.

### D4. Supervision that survives a reboot

A new `manor-host supervisor install | uninstall | status` puts the host's
daemon and host server under the operating system's own supervisor. It runs
on the box through the transport's `exec`.

- **Linux with a systemd user manager.**
  - Two user units, `manor-host-daemon.service` and
    `manor-host-server.service`. Each `ExecStart`s the `~/.manor/bin/manor-host`
    shim in the foreground: `--namespace remote` (the daemon itself never
    detaches; today `LocalTransport.spawnDaemon` detaches it), and `serve`.
  - `Restart=on-failure` and `WantedBy=default.target`.
  - `EnvironmentFile=-~/.manor/remote/supervisor.env` passes D5's key
    variables.
  - **Boot without a login needs lingering.** `install` runs
    `loginctl enable-linger` and checks `Linger=yes`. If polkit refuses,
    `status` reports `linger: false`. The desktop then shows "Manor on
    \<host\> starts only after you log in there. Run `sudo loginctl
    enable-linger <user>` to start it at boot."
- **macOS.**
  - Two LaunchAgents, `sh.manor.host-daemon.plist` and
    `sh.manor.host-server.plist`, with `RunAtLoad` and `KeepAlive`. They are
    loaded with `launchctl bootstrap gui/<uid>`.
  - A LaunchAgent starts at login, so a headless Mac needs auto-login. The
    desktop says so.
  - A LaunchDaemon would need root, and is rejected.
- **Containers (no init system).** `manor-host supervise` runs in the
  foreground as the container's entrypoint.
  - It starts the daemon and the server as children through the shim, and
    restarts either one when it exits (with backoff).
  - It passes SIGTERM on to them.
  - It adopts a daemon or server that is already running (pid file, socket
    probe), and polls it instead of starting a second one.
  - After a node reboot, the pod's restart policy brings it back.
  - `supervisor status` reports `container` when `supervise` holds the pid
    file `~/.manor/remote/supervise.pid`.
- **Supervised lifecycle.** `install` writes `~/.manor/remote/supervisor.json`
  (`{kind: "systemd" | "launchd" | "container"}`). While that file exists:
  - `ensureServerRunning` and `LocalTransport` (namespace `remote`) start,
    stop and restart through the supervisor (`systemctl --user`,
    `launchctl kickstart -k`, or a signal to `supervise`). They never spawn
    a detached copy beside a supervised one.
  - The units run the **shim**, which pins the installed version. A tarball
    upgrade is therefore "install, then restart through the supervisor",
    and the new version runs from then on.
  - `manor-host restart` (daemon protocol bump, ADR-185) goes through the
    supervisor too.
- **No new daemon mode.** `manor-host --namespace remote` already runs the
  daemon attached; only its spawner detaches it. Its pid-file and socket
  handling (including ADR-228's `ownsPidFile` check) is unchanged.
- **After a reboot**, the daemon starts with no terminals. The host server
  starts, rejoins its relay room and reconciles agents whose sessions are
  gone (ADR-178 §6). A phone sees the host and can start new agents with the
  lid closed. Lost panes resume when someone opens them, as on reconnect
  today (ADR-227's `pty.create` delivers the resume). Agents are **not**
  resumed by themselves. See Scope.
- **Who turns it on.** A per-host switch, **"Keep Manor running when
  \<host\> restarts"**. A new owner-side method,
  `hosts.setSupervised(hostId, on)`, runs `supervisor install` or
  `uninstall`, and `hosts.serverStatus` gains `supervisor`
  (`{kind, linger?}` or null).
  - **On by default** for hosts added after this ADR, and for recipe hosts.
  - **Off for existing SSH hosts.** Writing systemd units onto a box the
    user already set up should be their decision. Their settings show the
    switch with a one-line suggestion.

Rejected: **a system-wide unit or LaunchDaemon.** It needs root, and the
host server must run as the user whose agents, repos and credentials it
serves.

### D5. Secrets from the environment, not the volume

ADR-225 D6, applied. A new `SecretBox` backend, **`key-file`**:
- **What it does.** AES-256-GCM with a 32-byte key, read from
  `MANOR_SECRET_KEY` (base64) or from the file `MANOR_SECRET_KEY_FILE` names
  (a mounted Kubernetes Secret, a Docker secret).
- **It goes first.** `pickHostSecretBox` picks it before systemd-creds
  whenever either variable is set.
- **ADR-226's persisted-choice rule applies.** A host that sealed with
  `key-file` and later starts without the key fails clearly ("Pairing keys
  were sealed with a key from MANOR_SECRET_KEY or MANOR_SECRET_KEY_FILE, and
  neither is set"). It never starts
  over with a new identity. A plaintext host upgrades itself to `key-file`
  the first time the key appears, as it already does for systemd-creds.
- **A key kept on the volume defeats the point.** When
  `MANOR_SECRET_KEY_FILE` resolves under `$HOME/.manor`, `hostServer.status()`
  reports `secretKeyOnVolume: true`, and the desktop warns as it does for
  plaintext.
- **Getting the key to the server.** The supervisor passes it:
  `supervisor.env` for units, the container environment for `supervise`.
  `server-bridge`'s detached spawn passes its own environment, as today.
- **The D8 templates create the key.** The Kubernetes template creates a
  Secret with 32 random bytes and mounts it. The Docker template uses a
  file outside the container's volume.

### D6. One identity per instance

Orca's lesson: an image snapshotted after the server ran hands every clone
the same identity. Here, every clone would join the **same relay room**, and
each one's phones would see the others' agents.

- **What the host server records.** Next to its relay identity, it stores
  the `instanceId` it was created under:
  - `MANOR_INSTANCE_ID` if set (recipes set it to their resource id, and
    templates pass it into the container);
  - otherwise `/etc/machine-id`, but only when the supervisor kind is
    `systemd`;
  - otherwise the macOS `IOPlatformUUID` under `launchd`;
  - otherwise nothing, and no check.
- **On start, a different `instanceId`** means the data dir was copied. The
  server keeps projects, agents and layout. It wipes every sealed store:
  - the relay identity, which gives it a new room;
  - devices and push subscriptions;
  - the VAPID key;
  - the Linear token.

  It logs `cloned data dir: identity reset`, and `hostServer.status()`
  reports `identityReset: "cloned"` once, so the desktop can say why phones
  need re-linking. ADR-228 D9's `linkHostPairings` re-links phones paired
  with the desktop on their next hello.
- **Why not machine-id everywhere.** Containers often share the image's
  `/etc/machine-id`, or generate a new one on each start. A false "cloned"
  would unpair every phone on every pod restart, and a missed one is no
  worse than today.

### D7. The host decides when it is busy

ADR-178 §1's keep-awake rule, moved to the authority that can see it with
the lid closed:

- **`busy` is computed on the host server.** It is true when any agent on
  the host is in `thinking`, `working` or `requires_input` (the reconciler's
  `ACTIVE_STATUSES`). `requires_input` counts, as ADR-178 decided: an
  overnight prompt must still be there in the morning.
  - It is reported as `hostServer.status().busy`, and as a
    `hostServer.busyChanged` owner event.
  - Going idle is debounced by 60 s, so a prompt-and-answer doesn't flap.
- **Hooks on the box.** On each transition, the host server runs
  `~/.manor/remote/hooks/on-busy` or `on-idle` if it is executable, with a
  30 s timeout and its output logged.
  - The hook is how a recipe keeps a provider awake, or lets it sleep, with
    the lid closed. Examples: touch a provider's activity file, or call the
    provider's self-stop API after a grace period.
  - Templates install their hooks in `up`.
  - Manor knows no provider here.
- **The desktop, while awake:**
  - `BackendRegistry` calls `provider.setBusy(busy)` from the event.
  - For a recipe with `idleStopMinutes`, the desktop calls `stop()` once the
    host has been idle that long **and** no window has one of its panes
    mounted. A stop is never sent while busy.
  - With the lid closed, idle stop is the box hook's job, or the provider's
    own `autoSleep`.
- **Phones.**
  - A sleeping host shows as **Asleep** in the phone's Hosts sheet and
    sidebar.
  - **Wake** calls `hosts.wake` on home. That works when home is a desktop
    that lists the host.
  - When the desktop is away, the sheet says "wsl-pod is asleep, and This
    Mac is away". Nothing on the relay can start a stopped box.

### D8. Templates, an image and a Hosts page

- **Templates** are bundled in the app as modules under
  `electron/backend/providers/recipe-templates/<template>.ts`. Each one
  exports its script files and form fields, so packaging doesn't change.
  Creating a recipe from one writes its scripts into
  `~/.manor/host-recipes/<id>/` and writes `recipe.json` from a short form.
  This slice ships two:
  - **`docker`**: a Docker container on a local daemon (as built: the key
    file is a bind mount, so a remote daemon can't see it).
    - It is reached over exec (`docker exec -i`), with a named volume on
      `/home/manor`.
    - The entrypoint is `manor-host supervise`, and the key file is
      generated outside the volume.
    - It is the cheapest way to try the feature, and it is what the E2E
      drives.
  - **`kubernetes`**: a StatefulSet of one, with a PVC for the home
    directory and a Secret for `MANOR_SECRET_KEY`.
    - It is reached over `kubectl exec -i`, using a context and namespace
      from the form.
    - `stop` scales it to 0 and `up` scales it to 1. `destroy` deletes the
      StatefulSet, PVC and Secret after a typed confirmation.

  VMs and sandboxes with SSH (a cloud VM, Daytona, a Sprite with SSH) are a
  **custom recipe**. `docs/hosts/recipes.md` gives the contract and a
  worked SSH example. A third template can follow once one is proven in use.
- **The reference image** is `docker/host-image/Dockerfile` in the repo: Node 22,
  git, gh, tini, a `manor` user, and `manor-host-entrypoint.sh`.
  - The entrypoint waits for `~/.manor/bin/manor-host` (the first connect's
    bootstrap installs it on the volume), then execs `manor-host supervise`.
  - Later versions arrive through the normal tarball upgrade. Nothing about
    Manor is baked into the image, so a snapshot of it holds no identity
    (D6).
  - Agent CLIs are the user's to add. The Dockerfile has a commented line
    for each.
- **The Hosts settings page** (`src/components/settings/HostsPage/`) is new.
  The page lists every host with its status, including **Asleep**. It
  offers:
  - **Add host**, with two choices:
    - **An SSH box** (today's target field, moved here from
      `ProjectHostSection`, which keeps a link to it);
    - **Start a host**: pick a template or "custom recipe", fill in its
      form, then Manor runs `up` with streamed progress.
  - For each host:
    - **Wake** and **Stop**, where the capabilities allow them;
    - the D4 supervision switch and its status;
    - **Remove**, with two levels.
  - **Remove from Manor** forgets the host: `hosts.remove`,
    `registry.unregister`, the host cache and its group memberships.
  - **Destroy host and its disk** runs the recipe's `destroy` first. It
    lists the projects that live only on that host (ADR-227: the host is
    their source of truth) and asks for the host's name to be typed.
  - Only the owner may call either one.
- **`HostPhoneAccess`** stays where it is (Remote control page). The Hosts
  page links to it per host.

### Scope

**In scope:** D1–D8.

**Out of scope:**
- **One-click vendor providers** (Sprites, Daytona, E2B, Codespaces) as
  their own `kind`. Recipes cover them now.
- **One host per workspace** (Orca's model). ADR-178 keeps one box per
  project.
- **Resuming agents by themselves after a reboot.** Panes come back when
  opened, as today. An agent that restarts with nobody watching could
  repeat side effects. That needs its own decision.
- **Waking a stopped host from the phone while the desktop is away.** It
  would need the relay, or a cloud service, to hold provider credentials,
  which ADR-225 D8 rejects.
- **Billing, quotas and cost display.**
- **ADR-228's known limits.** They are routing work, and they stay listed
  there.

## Consequences

**Better**
- **"Run the tarball somewhere" is real** (ADR-225's promise for this
  slice). A pod, a container or a fresh VM becomes a Manor host from a form,
  and it brings its host server, relay room and phone access with it.
- **A reboot no longer takes a host offline until the laptop returns.** The
  phone sees the host with the lid closed after the box restarts.
- **Secrets on hosts we start are sealed by a key that isn't on their
  disk.** A copied volume or a leaked snapshot holds nothing usable.
- **Clones can't share a relay room.**
- **Keep-awake is decided where the agents are.** It works with the lid
  closed through box hooks, and a sleeping host stays asleep until someone
  means to use it.
- **Hosts can finally be removed.**

**Harder**
- **Two transports.** SSH and exec share bridge code (`BridgeSpawner`), but
  port forwards and host keys differ. Exec has no ControlMaster, so it
  spends a process per stream.
- **Recipes are user code.** Manor validates their output strictly and
  times them out, but a bad `destroy` can delete the wrong thing. The typed
  confirmation and the `resource` round-trip are the only guards. The
  scripts are the user's, as in Orca.
- **Three supervisors** (systemd, launchd, `supervise`) each need a test,
  and lifecycle code branches on "supervised or not". The branch is behind
  one `Supervisor` interface, and it is not scattered.
- **Destroy is final.** The host owns its projects' Manor metadata
  (ADR-227), so destroying it loses workspace names, folders and linked
  issues. Branches pushed to `origin` survive.

**Risks**
- **Lingering is often off**, and turning it on can need root. Without it, a
  systemd host still comes back only at login. The status says so instead of
  pretending.
- **A false "cloned" detection unpairs phones.** D6 limits the check to
  sources that are stable per machine, and `MANOR_INSTANCE_ID` lets a recipe
  be exact.
- **Idle stop with the lid closed depends on the recipe's hook.** A recipe
  without one, on a provider without `autoSleep`, runs until the desktop
  returns. The Hosts page shows "Stops after 30 min idle only while This Mac
  is awake" for such a recipe.
- **`kubectl exec` streams can be cut by the API server's idle timeouts.**
  The bridges already reconnect with backoff (ADR-169). The E2E covers a
  forced drop on the Docker template.

## Built beyond the tickets

- **Fixes found by the Docker E2E (ticket 9).** Each is a bug in an earlier
  ticket that only a real container showed:
  - Template `stop` and `destroy` printed no JSON, so Stop and Destroy
    failed on every template host. They now print `{}`.
  - The host image lacked node-pty's build toolchain. It now has
    python3, make and g++, plus iproute2 for `ss`.
  - Panes died on hosts reached without `$SHELL` (exec transports and
    supervisors). The daemon now falls back to the passwd login shell and
    sets `SHELL` for panes (`defaultShell()` in `session.ts`).
  - The desktop's first `supervisor install` raced the container
    entrypoint. `supervise` now records itself as the container supervisor
    when it starts.
- **Writes that never wake.** Beyond the reads D1 spares, `NEVER_WAKES`
  in `electron/bridge/routes.ts` keeps a sleeping host asleep for pane
  writes, resizes, detaches and closes (opening the pane is what wakes it)
  and for `agents.markSeen` and `agents.setPaneContext`.
- **Idle time is measured on the box.** Status carries `idleForMs`, so a
  box whose clock is off doesn't stop early or late.
- **SSH recipe hosts.** They get `HostKeyAlias manor-<hostId>` (the key
  survives a new address), `GlobalKnownHostsFile /dev/null` and
  `CheckHostIP no`, and their own wording for auth and host-key errors.
- **Recipe bookkeeping.** `host.json` beside `recipe.json` keeps the last
  `resource` and state, so a recipe with no `status` stays asleep across
  restarts. `MANOR_INSTANCE_ID` comes from `resource` (a string or `.id`),
  else the host id.
- **`supervise` signals.** SIGUSR1 restarts the server, SIGUSR2 the daemon,
  and SIGHUP starts whichever is down. `supervisor.env` keeps earlier
  values.
- **Hosts page extras.** A custom recipe gets a "Create recipe folder"
  skeleton (`hosts.createCustomRecipe`). There is a "Settings: Hosts"
  command, and the destroy dialog reads `hosts.projectsOnHost`.
- **Removing a host removes its projects** from this desktop, and their
  groups shrink or dissolve. Otherwise they would point at a host that no
  longer exists.
- **Tests.** The harness has a `--recipe` mode
  (`MANOR_E2E_RECIPE_KEEP=1` keeps the container). Three timing-sensitive
  tests (chat mirror, branch watcher) now wait on conditions instead of
  fixed delays.

## Known limits as built

**Waking and sleeping**
- ~~Restoring the visible workspace's panes at launch counts as using the
  host, so it wakes a sleeping host.~~ Fixed in ADR-230 (D3).
- A wake waits 2 min. After that a call answers "\<name\> is still
  starting" while `up` runs on (up to 15 min).
- ~~A reconnect after a drop reuses the last way in and doesn't re-run `up`.
  A box with a new address is found again only on the next full connect or
  wake.~~ Fixed in ADR-230 (D2): `up` re-runs once per drop.
- ~~Idle stop's "no pane mounted" is the host's view: a desktop window
  subscribed to some terminal's output. Phones don't count.~~ Fixed in
  ADR-230 (D1): phones and forwarded viewers count.

**Supervision and secrets**
- Turning supervision on doesn't move running processes under it; the
  supervisor takes over at the next restart or boot. Turning it off never
  stops anything. In a container it can't be turned off, because
  `supervise` is the entrypoint: the switch is shown on and locked, and
  `supervisor uninstall` refuses while `supervise` runs.
- Under systemd, a server stopped cleanly with `kill` isn't restarted by
  `Restart=on-failure` until the next connect. Use `systemctl --user
  restart`.
- `supervisor.env` is read only by systemd and launchd units. On an
  unsupervised SSH box, `MANOR_SECRET_KEY*` and `MANOR_INSTANCE_ID` reach
  the server only from the ssh session's environment.
- Setting a key later upgrades only a plaintext host, not one already on
  systemd-creds or libsecret.
- `supervise.pid` lives on the volume. A custom image whose old pid is
  reused by another process after a restart would make `supervise` refuse
  to start. The reference entrypoint doesn't hit this.
- The real `systemctl --user` test is gated behind `MANOR_TEST_SYSTEMD=1`
  and wasn't run, because install turns on lingering for the account.

**Templates and recipes**
- The Docker template bind-mounts `secret.key` from the recipe directory.
  It needs a local daemon (Docker Desktop, or Linux with the desktop user at
  uid 1000). The form's Docker context must name a daemon on this computer,
  such as `colima`; a remote one isn't supported.
- The Kubernetes template was syntax-checked only, never run against a
  cluster.
- "Remove from Manor" without destroy forgets the recipe's `resource`. A
  custom recipe that finds its box by `resource` may build a second one.
  Both templates find theirs by name.
- ~~port-pipe drops half-closed connections.~~ Fixed in ADR-230 (D4).
- The `loginctl enable-linger` hint guesses the user name.

**Coverage**
- **Docker E2E.** It covers up over exec, restart survival, stop and wake,
  clone detection, the busy hook, a port forward, a forced drop of the exec
  streams and destroy, all against a
  real daemon (`node scripts/test-remote-e2e.mjs --recipe`).
- **Gaps in the Docker E2E:**
  - Clone detection copies the volume rather than using `docker commit`.
  - Relay reachability is checked as an unchanged room id, not a live relay
    connection.
- **Unit and component tests only:** the desktop's busy and idle-stop path,
  Asleep and Wake on the phone, and the Hosts page.
- **Known failures in `--docker` mode,** recorded in
  `docs/remote-hosts.md#testing`. Both also fail on the base commit:
  - `host-direct-bridge` "without viewer-bridge";
  - `remote-host` "laptop closed" (flaky).
- **Flaky under load, unrelated to this ADR:** `terminal-host.test.ts`
  ("new client can attach…") and `exec-runner.test.ts` ("escalates to
  SIGKILL").

**Follow-ups**
- `test-remote-e2e.mjs --docker` uses `--progress=plain`, which needs
  buildx.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
