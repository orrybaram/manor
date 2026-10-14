---
title: E2E and docs
status: todo
priority: high
assignee: opus
blocked_by: [1, 2, 3, 4, 5, 6, 7, 8]
---

# E2E and docs

ADR-229, all decisions. See `docs/remote-hosts.md#testing` for the harness,
and the e2e notes for this WSL box in memory (DISPLAY, Node 22,
pre-existing failures).

## E2E

Add a `--recipe` mode to `scripts/test-remote-e2e.mjs`. It builds
`docker/host-image` as `manor-host:e2e` and needs Docker; skip it with a
clear message when Docker is absent. Scenarios, as vitest-level remote tests
or Playwright (whichever the harness already uses for each kind):

1. **Docker template up over exec.** Create a recipe from the `docker`
   template and add the host. Then:
   - `up` runs and bootstrap installs the tarball over `docker exec`;
   - the host server starts under `supervise`;
   - adoption completes;
   - a workspace is created, and an agent (`manor-e2e-agent`) runs and
     reports status.
2. **A reboot keeps the host server.** `docker restart` the container. The
   host server comes back with no desktop connect: its relay room is
   reachable, and `hostServer.status()` over a fresh `server-bridge` shows
   the same `roomId`. The `key-file` backend is in use, and the key is
   outside the volume. **Launch an agent after the restart** and check it
   starts. Under a supervisor the daemon gets a minimal environment, and
   only the PTY's login shell (`-l`) restores the user's PATH (ticket 5
   follow-up).
3. **Stop and wake.**
   - `hosts.stop` → status `sleeping`, and no reconnect attempts for 10 s.
   - A routed write (create a workspace) wakes it and succeeds.
4. **Clone detection.** Start a second container from a `docker commit` of
   the first's volume with a different `MANOR_INSTANCE_ID`. Its room
   differs, and its projects are kept.
5. **Busy hook.** With an `on-busy` hook that touches a file, a working
   agent creates the file inside the container.
6. **Port forward over exec.** A dev server on the container is reachable
   through `forwardPort`.
7. **Remove with destroy.** The container and volume are gone, and the host
   is no longer listed.

Run the existing remote e2e (SSH, `--docker`) to confirm no regression.
Record failures that also fail on main.

## Docs

- **`docs/remote-hosts.md`:**
  - replace "doesn't survive a reboot" with the supervision section
    (systemd + lingering, launchd + auto-login, containers);
  - add the `key-file` backend to the secrets section;
  - mention asleep hosts and Wake in "being away".
- **New `docs/hosts/recipes.md`:**
  - the recipe contract (files, env, stdin, stdout, timeouts, `up` result,
    `status` result, host keys);
  - the Docker and Kubernetes templates;
  - a worked custom SSH recipe for a cloud VM;
  - box hooks (`on-busy`, `on-idle`) with a self-stop example;
  - the snapshot warning (never snapshot `~/.manor/remote/server`; ADR-229
    D6);
  - `MANOR_INSTANCE_ID`.
- **`CONTEXT.md`:** add **Recipe**, **Supervisor** and **Asleep** to the
  glossary if they aren't there.
- **ADR-229 `index.md`:** add "Known limits as built". Candidates gathered
  so far:
  - restoring the visible workspace's panes at launch wakes a sleeping host
    (ticket 1);
  - a wake waits 2 min, then answers "\<name\> is still starting" while
    `up` runs on (ticket 4);
  - a reconnect after a drop reuses the last way in and doesn't re-run `up`,
    so a re-addressed box recovers only on the next full connect or wake
    (ticket 4);
  - port-pipe drops half-closed connections (ticket 2);
  - two tests (mirror, branch-watcher) were fixed for load timing in
    c2a0bafe, and mirror's `until()` again in ticket 5;
  - turning the switch on doesn't move running processes under the
    supervisor: install only enables, and the supervisor takes over at the
    next restart or boot. Turning it off never stops anything (ticket 5);
  - the real `systemctl --user` test is gated behind `MANOR_TEST_SYSTEMD=1`
    and wasn't run, because install turns on lingering for the account.

  Also document `MANOR_SECRET_KEY` / `MANOR_SECRET_KEY_FILE` at the
  "encrypting-pairing-keys" anchor that `HostPhoneAccess` links to (ticket
  3). Then add, and set
  `status: accepted` after integration verification.

## Files to touch
- `scripts/test-remote-e2e.mjs`, `tests/e2e/remote-host/*` (new recipe scenarios)
- `docs/remote-hosts.md`, new `docs/hosts/recipes.md`, `CONTEXT.md`
- `docs/decisions/adr-229-hosts-we-start/index.md`
