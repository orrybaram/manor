---
title: restartServer and the manor-host secrets command
status: in-progress
priority: high
assignee: opus
blocked_by: [1]
---

# restartServer and the manor-host secrets command

Implements ADR-236 D1 and D4. Read the ADR first.

1. **`restartServer(deps)` in `lifecycle.ts`.**
   - It inspects the server.
   - If one is live: when supervised, call `supervisor.stop("server")` and wait for the pid to die (fall back to `stopOld`'s SIGTERM/SIGKILL); when unsupervised, call `stopOld`.
   - Then call `ensureServerRunning(deps)` and return its result.
   - When no server is running, it just ensures one.
2. **`electron/host-server/secrets-command.ts`** (new): `runSecretsCommand(argv, io, deps)` with injectable deps (`choiceFile`, `envFile`, `keyFile`, `markerFile`, `restart`, `randomBytes`, `env`).
   - `encrypt --json` follows ADR D1 steps 1–7 exactly.
   - Use `validateSecretKey` and `writeSupervisorEnv` from ticket 1.
   - Write the key file with `wx`; create its directory 0700; the file is 0600.
   - Output is one JSON line: `{"secrets":{"backend","keyFile","place"}}` on success, `{"error":"…"}` with exit 1 on failure, mirroring `supervisor --json`.
   - `status --json` prints the facts with no side effects.
3. **`electron/terminal-host/index.ts`:** add modes `secrets` (dispatch to `runSecretsCommand`) and `restart-server` (call `restartServer`, print a one-line result). Update the header comment and usage.

## Files to touch
- `electron/host-server/lifecycle.ts`: `restartServer`
- `electron/host-server/secrets-command.ts`: new
- `electron/terminal-host/index.ts`: `secrets` and `restart-server` modes
- `electron/host-server/__tests__/lifecycle.test.ts`: restartServer supervised and detached, server down, stop ignoring SIGTERM
- `electron/host-server/__tests__/secrets-command.test.ts`: new. Cover:
  - the happy path (key 0600 in a 0700 dir, env line, restart called once, reports key-file)
  - a no-op when already on key-file or systemd-creds
  - reusing an existing valid key file
  - refusing an invalid key file, an invalid supervisor.env key, or a container
  - the still-plaintext error leaving the files in place
  - `status`
