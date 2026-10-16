---
title: Templates default to the published image and pull it when missing
status: in-progress
priority: critical
assignee: sonnet
blocked_by: [1]
---

# Templates default to the published image and pull it when missing

ADR-234 D2, D3 (slice 1).

- Default image for both templates: `ghcr.io/orrybaram/manor-host:<appVersion>`,
  computed when the form is described (use the same version source the host
  tarball / `ensureRemoteHost` uses; find it, don't hard-code). Put the
  repository name in one exported constant in `types.ts`. Replace the
  `manor-host:local` fallbacks in `recipe()`.
- Docker `up.sh`: before `run`, `docker image inspect "$image"`; when
  missing, print `manor-stage: Getting Manor's host image` and `docker pull`.
- Ship `docker/host-image/` as an electron-builder `extraResources` entry
  (`{ "from": "docker/host-image", "to": "host-image" }`) so ticket 7's
  "Build it on this computer instead" fix can find it at
  `process.resourcesPath/host-image` (dev: the repo path). Only ship it; the
  fix itself is ticket 7.
- Update `docs/hosts/recipes.md` (Image defaults, the build step is now
  optional) and `electron/backend/__tests__/recipe-templates.test.ts`.

## Files to touch
- `electron/backend/providers/recipe-templates/types.ts` — image constant
- `electron/backend/providers/recipe-templates/docker.ts` — default, pull step
- `electron/backend/providers/recipe-templates/kubernetes.ts` — default
- `package.json` — `build.extraResources`
- `docs/hosts/recipes.md`, `electron/backend/__tests__/recipe-templates.test.ts`
