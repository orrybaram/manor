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

# ADR-236: One-click pairing key encryption

## Context

When no stronger secret backend works on a host, the host server keeps its pairing keys (the sealed relay identity, paired-device and VAPID files) as plaintext files with mode 0600. Settings → Hosts warns "Pairing keys on <host> are stored unencrypted" and links to docs that ask the user to set `MANOR_SECRET_KEY_FILE` by hand and `kill` the server. Example: blade, a WSL2 Ubuntu box with systemd 255 (`systemd-creds --user` needs 256), no `secret-tool`, and the host server supervised by systemd.

The user wants a one-click fix. Research found:

- The backend is picked once, when `serve` starts (`electron/host-server/serve.ts:71`, `pickHostSecretBox` in `electron/platform/secret-box.ts`). A server on plaintext probes again on every start, and `upgradeFromPlaintext` re-seals every `*.enc` file, so phones stay paired. The fix therefore has two steps: make a stronger backend work, then restart the host server.
- Nothing restarts the host server. `manor-host restart` stops only the daemon. The docs' `kill "$(cat server.pid)"` advice doesn't even restart a systemd unit with `Restart=on-failure`.
- `uninstallSupervisor` deletes `supervisor.env` (`supervisor/index.ts:271`). A key named there would be lost when "Keep running" is turned off, and the next start would fail with "Pairing keys were sealed with a key from …, and neither is set".
- An unsupervised ssh host's server gets only the ssh session's environment (ADR-229 Known limits), so there `supervisor.env` never reaches it.
- `secretKeyOnVolume` flags only a `MANOR_SECRET_KEY_FILE` under `~/.manor`. An inline `MANOR_SECRET_KEY` in `supervisor.env` is on the same disk and isn't flagged.

The constraint underneath: on a bare box with no TPM-backed systemd-creds and no unlocked keyring, there is nowhere *off* the box that the server can read a key from at unattended boot. ADR-225 D6 rejected a desktop-held key because the server has to restart with the laptop lid closed. So one click can only put a key in a different place on the same disk.

## Decision

**A Manor-made key file outside `~/.manor`, named in `supervisor.env`, then a server restart.** The existing `key-file` backend and `upgradeFromPlaintext` do the re-sealing. The UI says exactly what this buys: a copy of `~/.manor` (a backup or rsync of the data dir, or a snapshot of a volume mounted there) can no longer read the pairing keys. A copy of the whole home directory or disk can.

### D1. `manor-host secrets encrypt --json` does the whole fix on the box
The desktop runs it through `provider.transport().exec`, as it runs `supervisor install --json` (`electron/backend/host-supervisor.ts`). Every step is idempotent:
1. Refuse in a container (`readSupervisorMarker() === "container"`): the container's environment gives it a key.
2. If `server/secret-backend` already names a backend other than `plaintext`, report it and exit 0.
3. If `supervisor.env` already names `MANOR_SECRET_KEY_FILE` or `MANOR_SECRET_KEY`, validate it: a 32-byte key, by the same rules as `readSecretKey`. Invalid is an error naming the file; the command never overwrites it and never starts a server that would crash-loop. Valid skips to step 6.
4. Key file `hostSecretKeyFile()`, which is `$XDG_CONFIG_HOME/manor/secret.key`, default `~/.config/manor/secret.key`. An existing valid key is reused, which covers a retry after a failed restart. An existing invalid one is an error and is never overwritten. Otherwise it writes 32 random bytes with `wx`, directory 0700, file 0600.
5. Merge `MANOR_SECRET_KEY_FILE='<path>'` into `supervisor.env`, using `writeSupervisorEnv` factored out of `installSupervisor`.
6. `restartServer()` (D4), then wait for a server of this version to listen.
7. Read `secret-backend` again. `key-file` means success; it reports `{backend, keyFile, place}`. Still `plaintext` is an error that points at `host-server.log`, and the key file and env line are left for the next try.

`manor-host secrets status --json` prints the same facts. The docs use it instead of `cat secret-backend`.

### D2. The host server reads `supervisor.env` itself
`manor-host serve` (`host-server/index.ts`, before `runServe`) fills each of `MANOR_SECRET_KEY_FILE`, `MANOR_SECRET_KEY` and `MANOR_INSTANCE_ID` that its environment lacks from `supervisor.env`. It does this through `applySupervisorEnv`, and the environment wins over the file. Unsupervised ssh hosts get the key too. It lives in `index.ts` rather than `runServe` so tests never read a developer's real file. **This amends ADR-229 D5 and closes its "supervisor.env is read only by units" known limit.**

### D3. `uninstallSupervisor` keeps `supervisor.env`
With D2 the file is the host's environment file, not the units'. **This amends ADR-229 D4's uninstall**, which removed the units, `supervisor.env` and the marker.

### D4. A restart-server command
`restartServer(deps)` in `host-server/lifecycle.ts` stops the live server: `supervisor.stop("server")` and a wait when supervised, `stopOld` (SIGTERM, then SIGKILL) otherwise. It then calls `ensureServerRunning`, which serialises on `server.lock`. `manor-host restart-server` exposes it for docs and manual use.

### D5. Status says where the key is
`HostServerStatus` gains:
- `secretKeyPlace?: "data-dir" | "home" | "elsewhere"`
  - `data-dir`: the key file is under `~/.manor`, or the inline `MANOR_SECRET_KEY` matches the one in `supervisor.env`.
  - `home`: the key file is under home but outside `~/.manor`.
  - `elsewhere`: a mounted Secret, or an inline key from the real environment.
- `secretKeyFile?: string | null`, the file's path with home shortened to `~`.

`secretKeyOnVolume` stays and equals `place === "data-dir"`, so an older desktop keeps its warning. The logic lives in `secretKeyPlace(env, home, inlineKeySources)` in `secret-box.ts`, which keeps `platform/` free of host-server imports.

### D6. The button, only where it can work
In `HostRow` `KeyWarnings`:
- **Plaintext, and the host is fixable** (not read-only, connected, not a recipe host, not supervised in a container): the warning stays, and below it sit a hint ("Manor can make a key at ~/.config/manor/secret.key on <host>… A copy of ~/.manor can't read them then; a copy of <host>'s whole disk still can.") and an **Encrypt them** `<Button>` (`host-encrypt-keys`). The button goes through `useHostAction().run`, so it gets the same busy state and `host-entry-error` as every other action.
- **Plaintext on a recipe host or in a container:** the warning plus a docs link explaining how to give it a key. No button.
- **Plaintext on a host that's away or read-only:** the warning as today.
- **`key-file` + `home`:** a muted `fieldHint` (`host-key-in-home`) says the keys are encrypted with a key kept at that path, which protects them from a copy of `~/.manor` but not of the disk. Nothing goes in the header line.
- **`data-dir`** (or `secretKeyOnVolume` from an older server): the existing yellow warning, reworded as "…kept inside ~/.manor on <host>, beside what it protects."

The copy lives as plain functions in `host-settings-text.ts`.

### D7. Desktop method `hosts.encryptKeys(hostId)`
`hostsEncryptKeys` in `electron/bridge/handlers/hosts.ts` is shaped like `hostsSetSupervised`. It calls `runHostSecrets(transport, "encrypt")` (new `electron/backend/host-secrets.ts`, 60 s timeout), waits up to about 15 s for the owner channel to reconnect, broadcasts `hosts.pairingChanged`, and returns the facts. It is registered `localOnly`, `mutating` and `LOCAL_ROUTE`, routed `home`, and added to `LOCAL_ONLY_METHODS` and `HostRefusedMethod`.

### D8. The choice is still sticky
Once a box is on `key-file`, a later systemd 256+ doesn't move it to systemd-creds (ADR-226). The docs say so; this ADR adds no migration.

### Rejected
- **Inline `MANOR_SECRET_KEY` in `supervisor.env`:** the key would sit in `~/.manor/remote/`, beside what it protects, so it is plaintext with one indirection.
- **A desktop-held key handed over on connect:** ADR-225 D6 rejected it, and that still holds; a supervised server that restarts at boot with the lid closed couldn't open its files.
- **Making systemd-creds or libsecret work in one click:** it needs sudo (packages, a systemd upgrade) and an unlocked keyring at boot. The server already probes both on every plaintext start.
- **No button, better copy only:** kept for the hosts where the fix can't work (recipe hosts, containers, away, read-only).

### Relation to earlier ADRs
- This reaffirms ADR-225 D6 and adds a weaker, honestly labelled tier below "a key from outside the box".
- It amends ADR-229 D4 (uninstall keeps `supervisor.env`) and ADR-229 D5 (the server reads `supervisor.env`; the known limit is closed).

## Consequences

- A plaintext ssh host can be moved to `key-file` in one click, and its phones stay paired.
- Unsupervised ssh hosts now honour `supervisor.env`.
- Turning "Keep running" off no longer risks stranding sealed keys.
- `manor-host restart-server` replaces the `kill` advice, which never restarted a systemd unit.
- The Hosts page is more honest. An inline key in `supervisor.env` is now flagged, and a key in home gets a quiet note rather than an all-clear.
- **Limited protection:** the protection is real but narrow. A whole-disk copy, or anyone with the user's account, can still read the keys, and the UI and docs say so.
- **Cost:** one more file on the box (`~/.config/manor/secret.key`). Deleting it strands the keys. The recovery is Reset pairing keys, so the docs warn about it.
- **Restart drops connections:** the restart drops the owner channel and phone connections for a few seconds.
- **Risk if the restart fails:** if the restart fails, the box keeps the key file and env line while staying on plaintext. The next start, or the next click, tries again.

- **Review findings:**
  - `restartServer` now holds `server.lock` from the stop through the start, so a bridge that connects partway can't race it.
  - The "kept inside ~/.manor" warning now needs `secretBackend === "key-file"`, so a systemd-creds host with an old inline key in `supervisor.env` doesn't get a false warning.
  - Busy hooks no longer inherit `MANOR_SECRET_KEY*` from the host server, because D2 now puts the key in the server's environment on every host.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
