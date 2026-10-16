---
title: Publish the multi-arch host image to GHCR from release.yml
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Publish the multi-arch host image to GHCR from release.yml

ADR-234 D1 (slice 1).

- Add a `host-image` job to `.github/workflows/release.yml` on `ubuntu-latest`
  with `permissions: { contents: read, packages: write }`.
- Steps: checkout; derive `VERSION="${GITHUB_REF_NAME#v}"`;
  `docker/setup-qemu-action`, `docker/setup-buildx-action`,
  `docker/login-action` (registry `ghcr.io`, user `${{ github.actor }}`,
  password `${{ secrets.GITHUB_TOKEN }}`); `docker/build-push-action` with
  `context: docker/host-image`, `platforms: linux/amd64,linux/arm64`,
  `push: true`, tags `ghcr.io/orrybaram/manor-host:$VERSION` and `:latest`,
  and an `org.opencontainers.image.source` label pointing at the repo (links
  the package to it). Use GHA cache (`cache-from/to: type=gha`).
- Split `Publish release` so it runs after both jobs (`needs: [release,
  host-image]`), or move it into a small final job; the existing `release`
  job keeps everything else as is.
- Header comment: the package must be set public once in GHCR package
  settings after the first push.
- Update `docker/host-image/README.md`: the published image is the default;
  building locally is for customising.

## Files to touch
- `.github/workflows/release.yml` — new job, release ordering
- `docker/host-image/README.md` — published image first
