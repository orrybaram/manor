---
title: Remote Docker over SSH in the Docker Connect step
status: done
priority: medium
assignee: opus
blocked_by: [9, 10]
---

# Remote Docker over SSH in the Docker Connect step

ADR-234 D12 (slice 4).

- Docker template: a `target` field "Run it on" (This computer / Another
  machine over SSH) plus `sshTarget` (shown only for the latter). In main,
  `recipe()` for an SSH target records context `manor-<sanitised host>`.
- Before Start (a fix, or on createRecipe): `docker context create
  manor-<host> --docker host=ssh://<target>` if missing; reuse if it points
  at the same host; error if a different one has that name.
- `checks/docker.ts`: with an SSH target, prepend: target answers over SSH
  (reuse the SSH path's probe and host-key trust handling from
  `ssh-provider.ts` / AddSshHostForm — find the shared function, don't copy),
  Docker installed there, user may use it (`permission denied … docker.sock`
  → detail with the `usermod -aG docker` command). The image check runs
  against the remote context.
- Where step copy (`AddHostDialog.tsx` PATHS): mention when the plain SSH
  path is simpler.
- Add the remote rows from the proposal's table to `recipe-failures.ts`.

## Files to touch
- `electron/backend/providers/recipe-templates/docker.ts`, `checks/docker.ts`
- `src/components/settings/HostsPage/StartHostForm.tsx`, `AddHostDialog.tsx`
- `src/lib/recipe-failures.ts`, docs, tests
