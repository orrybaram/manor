---
title: Remote Docker — recreate a missing context in up.sh, cache the SSH probe
status: done
priority: medium
assignee: sonnet
blocked_by: [11, 12]
---

# Remote Docker — recreate a missing context in up.sh, cache the SSH probe

Follow-ups from ticket 11 (ADR-234 D12).

- **A removed context breaks `up`.** A host whose `manor-<host>` docker
  context was deleted fails at `up`, and `up.sh` can't fix it. Record the
  target in the recipe (`MANOR_DOCKER_SSH_TARGET`) when "Run it on" is
  another machine, and have `up.sh` (before any docker call) create
  `manor-<host>` with `docker context create … --docker host=ssh://<target>`
  when it's missing, printing `manor-stage: Setting up Docker on <host>`.
  If a context of that name exists pointing elsewhere, fail with a one-line
  `manor:` reason. Only when the recipe's context is the derived one (not an
  explicit Advanced context).
- **The SSH probe runs on every refresh,** including every 2 s while the
  image row is busy during a remote pull. Cache a *passing* machine probe
  per target for ~15 s in the checks module (failures are never cached, so a
  fix shows up at once).
- Tests for both; docs line for the recreate behaviour.

## Files to touch
- `electron/backend/providers/recipe-templates/docker.ts`
- `electron/backend/providers/recipe-templates/checks/docker.ts`
- `electron/backend/__tests__/recipe-templates.test.ts`, `recipe-template-readiness.test.ts`
- `docs/hosts/recipes.md`
