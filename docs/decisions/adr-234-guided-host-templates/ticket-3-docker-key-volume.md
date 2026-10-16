---
title: Docker template keeps its key in a named volume
status: done
priority: high
assignee: sonnet
blocked_by: [2]
---

# Docker template keeps its key in a named volume

ADR-234 D4 (slice 2).

- `up.sh`: replace the recipe-dir key file and its bind mount with volume
  `manor-$name-key`, created if missing and filled once by
  `docker run --rm -u 0 --entrypoint sh -v "manor-$name-key:/k" "$image" -c '…'`
  (exact script in the ADR: umask 077, 32 random bytes, chown 1000:1000,
  chmod 400, only when `/k/secret.key` is empty/missing). Mount it at
  `/run/secrets/manor:ro`, `MANOR_SECRET_KEY_FILE=/run/secrets/manor/secret.key`.
  Print `manor-stage:` lines for "Creating the container".
- `destroy.sh`: remove `manor-$name-key` (if present) instead of the file.
- `context` field: drop "Must be a daemon on this computer…" from its
  description.
- Update the comment block at the top of `docker.ts`, the docker section of
  `docs/hosts/recipes.md`, the README's "must come from outside it" line,
  and the template tests (assert no `$key_file` bind, the volume is used and
  destroyed).
- Verify by hand if a Docker daemon is available: `up` twice keeps the same
  key; the container reads it as uid 1000.

## Files to touch
- `electron/backend/providers/recipe-templates/docker.ts`
- `docs/hosts/recipes.md`, `docker/host-image/README.md`
- `electron/backend/__tests__/recipe-templates.test.ts`
