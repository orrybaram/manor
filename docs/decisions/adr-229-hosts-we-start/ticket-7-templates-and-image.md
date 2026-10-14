---
title: Docker and Kubernetes templates, and the host image
status: in-progress
priority: medium
assignee: sonnet
blocked_by: [3, 4, 5]
---

# Docker and Kubernetes templates, and the host image

ADR-229 D8 (templates and image only; the UI is ticket 8).

## What to build

- **The host image**, `docker/host-image/`:
  - **`Dockerfile`:** a Node 22 Debian slim base with git, openssh-client,
    gh, tini, ca-certificates and procps.
    - A `manor` user (uid 1000) with home `/home/manor`.
    - Commented `RUN` lines for installing Claude Code and Codex.
    - `ENTRYPOINT ["tini", "--", "/usr/local/bin/manor-host-entrypoint.sh"]`.
  - **`manor-host-entrypoint.sh`:** wait (polling every 2 s, logging once)
    until `$HOME/.manor/bin/manor-host` exists, then
    `exec "$HOME/.manor/bin/manor-host" supervise`.
  - **`README.md`:** how to build and push it; why nothing Manor-specific is
    baked in (ADR-229 D6); where `HOME` must be persistent.
- **Templates** in `electron/backend/providers/recipe-templates/`. Each
  module exports `{id, name, description, fields: FormField[], files: Record<string, {content, mode}>, recipe: (values) => RecipeJson}`.
  - **`docker`**
    - Fields: container name (default `manor-<shortid>`), image (default
      `manor-host:local`), Docker context (optional).
    - `up.sh` (bash, `set -euo pipefail`, stdout reserved):
      - create the named volume `manor-<name>-home` if missing;
      - create the key file `$MANOR_RECIPE_DIR/secret.key` (32 random
        bytes, 0600) if missing — outside the volume;
      - `docker run -d --name … -v manor-<name>-home:/home/manor -v $MANOR_RECIPE_DIR/secret.key:/run/secrets/manor-key:ro -e MANOR_SECRET_KEY_FILE=/run/secrets/manor-key -e MANOR_INSTANCE_ID=<name> --restart unless-stopped <image>`
        if the container doesn't exist, and `docker start` if it is stopped;
      - install `~/.manor/remote/hooks/on-idle` / `on-busy` as no-op
        examples, only if absent;
      - print
        `{"schemaVersion":1,"resource":{"container":"<name>"},"connection":{"type":"exec","argv":["docker",…,"exec","-i","-u","manor","<name>"]}}`.
    - `status.sh`: `docker inspect -f '{{.State.Status}}'` → up, sleeping
      (exited or created) or missing.
    - `stop.sh`: `docker stop`.
    - `destroy.sh`: `docker rm -f`, then `docker volume rm`.
  - **`kubernetes`**
    - Fields: kubectl context, namespace (default `manor`), name, image,
      storage size (default 20Gi), storage class (optional).
    - `up.sh` applies, through `kubectl apply -f -` with a heredoc, a Secret
      `<name>-key` (generated once, only if missing) and a one-replica
      StatefulSet `<name>`. The StatefulSet has a `volumeClaimTemplate` for
      `/home/manor`, the key Secret mounted at `/run/secrets/manor-key`,
      `MANOR_SECRET_KEY_FILE` and `MANOR_INSTANCE_ID=<namespace>/<name>`.
      Then it scales to 1, waits with
      `kubectl rollout status --timeout=10m`, and prints an exec connection
      `["kubectl","--context",ctx,"-n",ns,"exec","-i","<name>-0","-c","host","--"]`.
    - `status.sh`: replicas 0 → sleeping; pod Ready → up; StatefulSet
      absent → missing.
    - `stop.sh`: scale to 0.
    - `destroy.sh`: delete the StatefulSet, the PVC
      (`home-<name>-0`) and the Secret.
  - Both templates' `up.sh` must check that their CLI exists (`command -v`)
    and fail with a clear stderr line.
- **`hosts.createRecipe(templateId, values)`** (owner-only). It writes
  `~/.manor/host-recipes/<id>/` with the template's files (and their modes)
  plus `recipe.json`, and returns the recipe id. `hosts.listTemplates()`
  returns the templates' metadata for the form.
- **Running the scripts.** They go through `recipe-runner.ts` like any
  user recipe. Nothing about templates is special after creation.

## Tests

- Template rendering: generated `recipe.json` validates against ticket 4's
  schema, and file modes are set.
- `shellcheck` the generated scripts if `shellcheck` is available in CI;
  otherwise `bash -n` each one.
- The Docker template is exercised for real in ticket 9's E2E.

## Files to touch
- new `docker/host-image/{Dockerfile,manor-host-entrypoint.sh,README.md}`
- new `electron/backend/providers/recipe-templates/{index,docker,kubernetes}.ts`
- `electron/bridge/handlers/hosts.ts`, `electron/bridge/routes.ts`
