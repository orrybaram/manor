---
title: Bake the version's host package into the image; bootstrap copies it
status: todo
priority: medium
assignee: opus
blocked_by: []
---

# Bake the version's host package into the image; bootstrap copies it

ADR-235 D10. **Prerequisite outside this ADR:** ADR-234 ticket 1 (the
`host-image` job in `release.yml`).

**Image**
- `docker/host-image/Dockerfile`: a build arg `MANOR_HOST_TARBALL`
  (optional). When given, `COPY` it, extract it to
  `/opt/manor/host-${VERSION}/`, run `npm install --omit=dev --no-audit
  --no-fund --no-package-lock` there as root, fix the `spawn-helper` exec
  bit as `buildInstallCommands` does, verify `node -e 'require("node-pty")'`,
  and `chown -R root:root`, read-only for others. Without the arg the image
  is built as today (local builds still work).
- `release.yml` `host-image` job: build the tarball first
  (`scripts/build-host-tarball.mjs`), pass it as the build arg, and pass
  `VERSION`. It builds for both arches; arm64 compiles under QEMU, so raise
  the job timeout if needed.

**Bootstrap** (`electron/backend/remote-bootstrap.ts`):
- In `ensureRemoteHost`, after the version check finds a mismatch or no
  install, probe `test -d /opt/manor/host-<appVersion> && <node> -e
  'require("/opt/manor/host-<appVersion>/node_modules/node-pty")'`.
- If it passes, `buildInstallCommands` gets a `source: "baked"` variant: `cp
  -a /opt/manor/host-<v>/. <staging>/` instead of piping the tarball and
  running npm. Then the same lock, swap, shims and hooks refresh.
- Otherwise use today's upload path. Report the phase message "Installing
  Manor" either way. The ADR-234 compile message appears only on the npm
  path.

**Docs**: `docker/host-image/README.md` and `docs/hosts/recipes.md` "never
snapshot" section: the image may hold Manor code, never Manor state;
`~/.manor/remote/server/` is still on the volume only.

Tests: unit-test the command builder for both variants, and the probe
parsing.

## Files to touch
- `docker/host-image/Dockerfile`, `docker/host-image/README.md`
- `.github/workflows/release.yml`
- `electron/backend/remote-bootstrap.ts` + tests
- `docs/hosts/recipes.md`
