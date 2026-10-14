---
title: The harness's --k8s mode on a kind cluster
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# The harness's `--k8s` mode on a kind cluster

ADR-231 D1. This adds a mode to `scripts/test-remote-e2e.mjs` that brings
up a kind cluster and runs the Kubernetes recipe suite (ticket 4) against
it. Until ticket 4 lands, it runs a placeholder smoke check (below).

## What to build

- **Flags.**
  - `--k8s` selects the mode. Document it in the file header and in the
    usage block, next to `--recipe`.
  - `--no-build` applies, as for `--recipe`.
- **Docker.** The same check as `runRecipe`: without Docker, log a skip
  message and exit 0.
- **Binaries.**
  - `ensureTool(name)` uses `kind` or `kubectl` from `PATH` if present.
  - Otherwise it downloads a pinned version into
    `~/.cache/manor-e2e/bin/<name>-<version>`, checks its SHA-256 against a
    constant in the script, `chmod 755`s it, and puts that directory first
    on the suite's `PATH`.
  - Pin the latest kind release that is at least two weeks old, and the
    kubectl minor that matches its default node image. Write the URLs for
    linux/amd64, linux/arm64, darwin/amd64 and darwin/arm64, each with its
    checksum from the release's published `.sha256` files.
  - A checksum mismatch is fatal, and deletes the file.
- **The cluster.**
  - Run `kind create cluster --name manor-e2e --kubeconfig <tmp>/kubeconfig --image kindest/node:<version>@sha256:<digest> --wait 120s`,
    unless a cluster of that name already exists (`kind get clusters`).
    Then reuse it and write its kubeconfig with
    `kind get kubeconfig --name manor-e2e > <tmp>/kubeconfig`.
  - Never touch `~/.kube/config`: always pass `--kubeconfig`, and give the
    suite `KUBECONFIG=<tmp>/kubeconfig`.
- **The image.** Build `manor-host:e2e` as `runRecipe` does, then
  `kind load docker-image manor-host:e2e --name manor-e2e`.
- **Run.** `pnpm exec vitest run electron/backend/__tests__/recipe-kubernetes.e2e.test.ts`
  with `MANOR_E2E_K8S=1`, `MANOR_E2E_K8S_IMAGE=manor-host:e2e`, `KUBECONFIG`
  and `PATH`.
- **Teardown.** `kind delete cluster --name manor-e2e`, also on
  SIGINT/SIGTERM, unless `MANOR_E2E_K8S_KEEP=1`. Then log how to delete
  it by hand.
- **Smoke.** `--k8s --smoke` brings the cluster up, loads the image, and
  runs `kubectl get nodes` and `kubectl auth can-i create statefulsets`.
  It also runs a throwaway pod from `manor-host:e2e` with
  `kubectl run … --image-pull-policy=Never --command -- node --version`,
  then tears everything down.
- Share code with `runRecipe` (the Docker check, the image build) rather
  than copying it.

## Verify

`sg docker -c 'node scripts/test-remote-e2e.mjs --k8s --smoke --no-build'`
passes on this machine. Run it twice: the second run reuses the cached
binaries. `~/.kube/config` is unchanged (compare its mtime, or that it
doesn't exist).

## Files to touch
- `scripts/test-remote-e2e.mjs`: the mode, `ensureTool`, cluster lifecycle, smoke.
