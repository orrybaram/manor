---
title: Supervision that survives a reboot
status: todo
priority: high
assignee: opus
blocked_by: [1, 2]
---

# Supervision that survives a reboot

ADR-229 D4. Put the host's daemon and host server under systemd (user),
launchd (LaunchAgent) or `manor-host supervise` (containers), and make the
lifecycle code defer to it.

## What to build

- **`electron/host-server/supervisor/`** (new), behind one interface:

  ```ts
  interface Supervisor {
    kind: "systemd" | "launchd" | "container";
    install(): Promise<void>;
    uninstall(): Promise<void>;
    status(): Promise<{ kind; running: { daemon: boolean; server: boolean }; linger?: boolean }>;
    start(unit: "daemon" | "server"): Promise<void>;
    restart(unit: "daemon" | "server"): Promise<void>;
    stop(unit: "daemon" | "server"): Promise<void>;
  }
  ```

  - **systemd.**
    - Write `~/.config/systemd/user/manor-host-daemon.service` and
      `manor-host-server.service`. `ExecStart` is
      `%h/.manor/bin/manor-host --namespace remote` or
      `%h/.manor/bin/manor-host serve`, with `Restart=on-failure`,
      `EnvironmentFile=-%h/.manor/remote/supervisor.env` and
      `WantedBy=default.target`.
    - Then `systemctl --user daemon-reload` and `enable --now`.
    - Lingering: run `loginctl enable-linger` (ignore a refusal), then read
      `loginctl show-user $USER -p Linger`.
    - Detect it with `systemctl --user is-system-running` succeeding (any
      state but "offline").
  - **launchd.** Write `~/Library/LaunchAgents/sh.manor.host-daemon.plist`
    and `sh.manor.host-server.plist` with `RunAtLoad` and `KeepAlive`,
    stdout and stderr to the existing log files, and env from
    `supervisor.env`. Then `launchctl bootstrap gui/$(id -u)`. Restart is
    `launchctl kickstart -k`.
  - **container.**
    - `install` only records the kind. It is valid only when
      `supervise.pid` names a live process.
    - `restart` signals `supervise` (SIGUSR1 = restart server, SIGUSR2 =
      restart daemon), or kills the child and lets `supervise` restart it.
      Pick one and document it.
  - `install` writes `~/.manor/remote/supervisor.json` (`{kind}`);
    `uninstall` removes the units or plists and the marker.
- **`manor-host supervisor install|uninstall|status [--json]`** and
  **`manor-host supervise`**: new modes in `electron/terminal-host/index.ts`.
  - `install` picks systemd, then launchd, then container (only if
    `supervise` is running), else fails with "No supervisor on this host".
  - `supervise` runs in the foreground:
    - it starts the daemon (`--namespace remote`) and the server (`serve`)
      through the shim, so it always runs the installed version;
    - it adopts already-running ones (pid file plus socket probe) and polls
      them every 2 s;
    - it restarts on exit with backoff (1 s to 30 s);
    - it forwards SIGTERM and SIGINT, and exits after its children do;
    - it writes `supervise.pid`.
- **Supervised lifecycle.** When `supervisor.json` exists:
  - `host-server/lifecycle.ts` `ensureServerRunning`: a stale version
    becomes `supervisor.restart("server")` and down becomes
    `supervisor.start("server")`. It then waits for the socket as today. It
    never spawns detached.
  - `LocalTransport` (namespace `remote` only): `ensureRunning`, `restart`
    and `stop` go through the supervisor the same way. `manor-host restart`
    therefore restarts through it too.
  - Local (desktop) namespace behaviour is untouched.
  - A marker whose supervisor no longer works (units deleted by hand) falls
    back to today's detached spawn and logs a warning. A host must never end
    up with nothing running.
- **`supervisor.env`** holds `MANOR_SECRET_KEY_FILE` / `MANOR_SECRET_KEY` and
  `MANOR_INSTANCE_ID` when they were set in the environment that ran
  `install`. The file is 0600. Document that `MANOR_SECRET_KEY` there is on
  the volume (ticket 3's warning catches the `_FILE` form).
- **Desktop.**
  - `hosts.setSupervised(hostId, on)` (owner-only) runs
    `~/.manor/bin/manor-host supervisor install|uninstall --json` through
    the host transport's `exec`.
  - `hosts.serverStatus` gains `supervisor: {kind, linger?} | null`, from
    `supervisor status --json` (or `hostServer.status()`; add `supervisor`
    there too, read from the marker plus `status()`).
  - `PersistedHost.supervise?: boolean`:
    - set to true for hosts added after this change and for recipe hosts;
    - on connect, when true and the status shows none, install it;
    - existing hosts keep it absent, which means off.

## Tests

- Unit-file and plist generation (snapshot the text).
- `pickSupervisor` with fake probes.
- `supervise` with fake children: restart with backoff, adopt a running
  pid, SIGTERM fan-out.
- `lifecycle.ts`: with a marker, stale → `restart("server")` and no spawn;
  a broken supervisor falls back to spawn.
- `LocalTransport` remote namespace through a fake supervisor.
- Linux CI can't run a user systemd. Gate a real `systemctl --user` test
  behind `MANOR_TEST_SYSTEMD=1`.

## Files to touch
- new `electron/host-server/supervisor/{index,systemd,launchd,container,supervise}.ts`
- `electron/host-server/lifecycle.ts`, `electron/terminal-host/transport-local.ts`, `electron/terminal-host/index.ts`
- `electron/host-server/relay.ts` (status field)
- `electron/bridge/handlers/hosts.ts`, `electron/bridge/routes.ts`, `electron/projects/types.ts`, `electron/backend/host-server-sync.ts` (install-on-connect)
- `src/components/settings/HostPhoneAccess.tsx` only if the status type change needs it (the switch UI is ticket 8)
