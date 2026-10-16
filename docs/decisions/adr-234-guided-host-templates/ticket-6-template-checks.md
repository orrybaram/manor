---
title: Template readiness checks and one-click fixes in main
status: todo
priority: high
assignee: opus
blocked_by: [5]
---

# Template readiness checks and one-click fixes in main

ADR-234 D8 (slice 3).

- Fill `checks` in `checks/docker.ts` and `checks/kubernetes.ts`, in the
  order the ADR lists; a check whose predecessor isn't `ok` is `todo`.
  Every probe has a timeout; a timeout is `bad` with a plain detail.
  - Docker: CLI on PATH; daemon (`docker [--context] info --format json`:
    server version, OS/arch); image (`docker image inspect`).
  - Kubernetes: kubectl on PATH; cluster answers (`kubectl --context X
    version -o json`; recognise "executable … not found" for exec credential
    plugins and name the helper); permissions (`kubectl auth can-i` for
    create namespaces-or-namespace-exists, statefulsets, secrets,
    persistentvolumeclaims, pods/exec — on failure, list namespaces where all
    pass as `choices.namespace` and offer a set-field fix); default
    StorageClass (on none, list classes as `choices.storageClass`, set-field fix).
- `hosts.runTemplateFix(templateId, fixId, values)`:
  - open-url (via `shell.openExternal`), open-app (`open -a Docker` on macOS,
    `systemctl --user start docker-desktop` on Linux; no fix offered where
    neither applies),
  - pull-image: starts `docker pull` in the background keyed by
    context+image (idempotent), parses layer progress; while running the
    image check is `busy` with "N of M MB"; finished → next check run sees
    it present. Failure is remembered and shown as the image check's detail,
    and offers `build-image` which runs
    `docker build -t <image> <resourcesPath>/host-image` the same way.
  - set-field fixes are returned as `{ id, label, set: { key, value } }` and
    applied by the renderer — no IPC.
- Wire the IPC like `checkTemplate`. Tests with faked execFile for every
  state of every check.

## Files to touch
- `electron/backend/providers/recipe-templates/checks/*.ts`, `types.ts`
- `electron/bridge/handlers/hosts.ts`, `routes.ts`, `local-only.ts`
- `src/bridge/unavailable.ts`, `src/electron.d.ts`
- tests under `electron/backend/__tests__/`
