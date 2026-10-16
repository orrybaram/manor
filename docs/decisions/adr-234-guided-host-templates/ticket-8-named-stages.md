---
title: Named startup stages and the Kubernetes fail-fast wait
status: todo
priority: medium
assignee: opus
blocked_by: [5]
---

# Named startup stages and the Kubernetes fail-fast wait

ADR-234 D9 (slice 3).

- Recipe protocol: a stderr line `manor-stage: <text>` sets the host's
  progress to `<text>`; other lines still go to the output but no longer
  replace a stage while one is set during that run. Implement in
  `recipe-provider.ts` where `onProgress` lines are forwarded. Document it in
  `docs/hosts/recipes.md` (optional for custom recipes).
- Docker `up.sh`: stage lines for image, container, agents (ticket 10).
- Kubernetes `up.sh`: replace `rollout status --timeout=10m` with a bash loop
  (poll every 3 s, overall cap 15 min) that prints stages "Getting a disk"
  (PVC `home-$name-0` phase), "Finding room on the cluster" (pod
  PodScheduled), "Downloading the image" (container waiting reason
  ContainerCreating/pulling), "Starting" → Ready. Fail fast, printing the
  event message and exiting 1, on: PVC Pending > 60 s with a
  `ProvisioningFailed` or no-provisioner event; `FailedScheduling`
  repeated > 60 s; container waiting reason `ErrImagePull`,
  `ImagePullBackOff`, `CreateContainerConfigError`, `InvalidImageName`;
  terminated `OOMKilled`. Use `kubectl get … -o jsonpath` and
  `kubectl get events --field-selector involvedObject.name=…`.
- Bootstrap: when the install phase will compile node-pty (Linux, no
  prebuild), its message reads "Installing Manor — building terminal
  support, this only happens once (about 2 minutes)".
- Tests: stage parsing in recipe-provider; template content assertions.

## Files to touch
- `electron/backend/providers/recipe-provider.ts`
- `electron/backend/providers/recipe-templates/{docker,kubernetes}.ts`
- `electron/backend/remote-bootstrap.ts` — install message
- `docs/hosts/recipes.md`, tests
