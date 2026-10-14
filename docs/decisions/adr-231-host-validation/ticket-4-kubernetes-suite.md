---
title: The Kubernetes recipe suite, and the template fixes it finds
status: todo
priority: high
assignee: opus
blocked_by: [2, 3]
---

# The Kubernetes recipe suite, and the template fixes it finds

ADR-231 D3. Read Context C1 and Decision D3 first.

## What to build

`electron/backend/__tests__/recipe-kubernetes.e2e.test.ts`, on the shared
harness from ticket 3. It is skipped unless `MANOR_E2E_K8S=1`. When that is
set but `kubectl` can't reach the cluster or the image isn't loaded, it
throws a clear error rather than skipping silently, as the Docker suite
does.

- **Setup.**
  - `createRecipeFromTemplate("kubernetes", {namespace: "manor-e2e-<suffix>", name: "manor-e2e-<suffix>", image: MANOR_E2E_K8S_IMAGE, storage: "1Gi"})`.
    Leave the context blank: `KUBECONFIG` selects the cluster.
  - Patch the generated `up.sh` so the container's env gains
    `MANOR_RELAY_URL=http://127.0.0.1:9`. Assert the marker line exists,
    as the Docker suite does.
- **`BoxExec`.** `kubectl -n <ns> exec -i <name>-0 -c host -- sh -c <cmd>`.
- **Scenarios,** in this order: 1, 5, 6, 10, 8, 2, 3, 7. They are listed
  in ADR-231 D3.
  - **Scenario 2, the pod deleted.**
    - Connected half: record the statuses, run `kubectl delete pod
      <name>-0 --wait=false`, then poll until the host is `connected`
      again. Assert `sleeping` never appears in the statuses since the
      delete, and the owner channel reaches the same relay room.
    - Disconnected half: `registry.disconnect` first, delete the pod, wait
      for the new pod's host server (`serverPid` via `BoxExec`) with
      `supervise` as its parent. Assert `secret-backend` is `key-file` and
      `MANOR_SECRET_KEY_FILE` is `/run/secrets/manor-key`. Through a fresh
      owner channel, assert the same room id, `secretKeyOnVolume` falsy
      and no `identityReset`. Then reconnect and launch an agent.
  - **Scenario 3, stop and wake.**
    - Stop: `kubectl get sts -o jsonpath={.spec.replicas}` reads 0, and
      the pod is gone.
    - Wake: replicas read 1, and the routed `createWorktree` succeeds.
  - **Scenario 7, destroy.** The StatefulSet, `pvc/home-<name>-0` and
    `secret/<name>-key` are all NotFound.
  - `afterAll` deletes the namespace (`--wait=false`) unless
    `MANOR_E2E_K8S_KEEP=1`.
- **The harness.** Point ticket 2's `--k8s` run at this file, if it isn't
  already.

## Fix what it finds

- **Run it before changing the template.** Record each failure: the
  scenario, the error, and the cause.
- **The expected one (C1).** `status.sh` says `sleeping` for a pod that
  isn't Ready, so scenario 2's connected half sees `sleeping` and stops
  reconnecting.
  - The fix: when `.spec.replicas` is 1 or more, print
    `{"state":"up","detail":"the pod is not ready yet"}` if the pod isn't
    Ready. Print `sleeping` only for 0 replicas.
  - Check that `RecipeHostProvider` passes `detail` through for `up`, or
    drop it.
- Fix every other template bug in `kubernetes.ts`. Where a script's text
  can show it, add a case to
  `electron/backend/__tests__/recipe-templates.test.ts`.
- If a failure is in shared desktop code rather than the template, fix it
  there with a unit test that fails on the base commit. Name it in the
  commit message.
- Each fix is its own commit, `fix(adr-231): …`, before the suite's
  passing commit.
- If scenario 2 shows a cause other than C1's, write down what you saw in
  the ticket (add a "Found" section) and fix that cause instead.

## Verify

- `sg docker -c 'node scripts/test-remote-e2e.mjs --k8s'` passes all
  scenarios twice in a row.
- `pnpm test:unit` shows no new failures. The baseline failures are in
  memory and in `docs/remote-hosts.md#testing`.
- Add a "Found" section to this ticket listing each bug the cluster showed.

## Files to touch
- `electron/backend/__tests__/recipe-kubernetes.e2e.test.ts` (new).
- `electron/backend/providers/recipe-templates/kubernetes.ts`: the fixes.
- `electron/backend/__tests__/recipe-templates.test.ts`: the regression cases.
- `scripts/test-remote-e2e.mjs`: only if ticket 2 left the suite path open.
