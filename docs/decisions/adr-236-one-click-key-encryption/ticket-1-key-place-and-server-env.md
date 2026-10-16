---
title: Honest key place in status, and the server reads supervisor.env
status: done
priority: high
assignee: opus
blocked_by: []
---

# Honest key place in status, and the server reads supervisor.env

Implements ADR-236 D2, D3 and D5. Read the ADR (`index.md` in this folder) first.

1. **Key place (D5).** In `secret-box.ts` add `secretKeyPlace(env, home, inlineKeySources: string[]): "data-dir" | "home" | "elsewhere" | null`. It is null when neither `MANOR_SECRET_KEY` nor `MANOR_SECRET_KEY_FILE` is set.
   - `data-dir`: the `MANOR_SECRET_KEY_FILE` realpath is under the `~/.manor` realpath, or `MANOR_SECRET_KEY` is set and one of `inlineKeySources` contains the line `MANOR_SECRET_KEY='<that value>'`.
   - `home`: the file is under home but outside `~/.manor`.
   - `elsewhere`: anything else, including an inline key from the environment.
   - `MANOR_SECRET_KEY` wins when both are set, as in `keyFileSecretBox`.
   - An unresolvable path counts as `elsewhere`, matching how today's function returns false.
   - Make `secretKeyOnVolume` a wrapper: `=== "data-dir"`. Keep its existing callers working.
   - Export a validation helper, such as `validateSecretKey(env)` returning `{ok} | {error}`, built on the same parsing as `readSecretKey`, for ticket 2 to reuse.
2. **Status.** On `HostServerStatus` (`relay.ts`) add optional `secretKeyPlace` and `secretKeyFile: string | null` (`$HOME` shortened to `~`; null for an inline key). `hostStatus()` in `server.ts` fills them, passing `[supervisorEnvFile()]` as the inline sources.
3. **The server reads supervisor.env (D2).** In `supervisor/index.ts` add `applySupervisorEnv(env: NodeJS.ProcessEnv, file: string)`. It fills only the allowed keys (`MANOR_SECRET_KEY_FILE`, `MANOR_SECRET_KEY`, `MANOR_INSTANCE_ID`) that are unset or empty in `env`, from `parseSupervisorEnv`. A missing file is a no-op.
   - Call it in `electron/host-server/index.ts` `main()` for the `serve` mode, before `runServe`. Don't call it inside `runServe`, so tests don't read the real file.
   - Careful: if both keys end up set, `MANOR_SECRET_KEY` wins. Don't fill `MANOR_SECRET_KEY` from the file when the environment already has `MANOR_SECRET_KEY_FILE`, and vice versa: the environment's choice of key source wins as a whole.
4. Factor `writeSupervisorEnv(file, values)` out of `installSupervisor`: merge with the previous file, validate values, write 0600. Ticket 2 uses it.
5. **D3.** `uninstallSupervisor` no longer removes `envFile`. Update its doc comment.
6. In `paths.ts` add `hostSecretKeyFile(env = process.env)`, which is `$XDG_CONFIG_HOME/manor/secret.key` with a fallback to `~/.config/manor/secret.key`. Note on `supervisorEnvFile` that the server reads it too.

## Files to touch
- `electron/platform/secret-box.ts`: `secretKeyPlace`, wrapper, validation helper
- `electron/host-server/supervisor/index.ts`: `applySupervisorEnv`, `writeSupervisorEnv`, uninstall keeps env
- `electron/host-server/index.ts`: apply supervisor.env before serve
- `electron/host-server/relay.ts`: `HostServerStatus` fields
- `electron/host-server/server.ts`: `hostStatus()` fills them
- `electron/paths.ts`: `hostSecretKeyFile`
- `electron/platform/__tests__/secret-box.test.ts`: place cases (file in data dir, inline matching supervisor.env, home, elsewhere, env-only inline, unset)
- `electron/host-server/__tests__/supervisor.test.ts`: applySupervisorEnv fills only unset keys and respects the environment's key source; uninstall keeps supervisor.env (flip the existing case); writeSupervisorEnv merges
