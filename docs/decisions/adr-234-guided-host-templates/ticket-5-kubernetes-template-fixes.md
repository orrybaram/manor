---
title: Kubernetes template — required cluster, hardened pod, sizes
status: done
priority: high
assignee: sonnet
blocked_by: [3, 4]
---

# Kubernetes template — required cluster, hardened pod, sizes

ADR-234 D5 (slice 2).

- `context` field: `type: "choice"`, `required: true`, label "Cluster",
  description in plain words ("kubectl's saved login for the cluster to run
  the host on"). `recipe()` throws without it. Preselect in the form: the
  context of the most recent existing `kubernetes` recipe if still listed,
  else none (never the current context). Reading existing recipes happens in
  main (`checks/kubernetes.ts` can return it as the first choice with a
  `preselect` flag, or add `default` to the choice result — pick one and keep
  it in the shared types).
- Scripts: `kubectl_cmd` always gets `--context` when set (unchanged for old
  recipes without it).
- Pod spec: the full securityContext from the ADR (pod: runAsNonRoot,
  runAsUser/Group 1000, fsGroup 1000, seccompProfile RuntimeDefault;
  container: allowPrivilegeEscalation false, capabilities drop ALL).
- `size` field (`type: "size"`, Small/Medium/Large, default Medium) →
  `MANOR_K8S_CPU` / `MANOR_K8S_MEMORY` (1/2Gi, 2/4Gi, 4/8Gi) →
  `resources.requests.{cpu,memory}` and `limits.memory`.
  Old recipes without these env vars render no resources block.
- Docs + tests (`recipe-templates.test.ts`: required context, securityContext
  present, resources per size).

## Files to touch
- `electron/backend/providers/recipe-templates/kubernetes.ts`
- `electron/backend/providers/recipe-templates/checks/kubernetes.ts`
- `docs/hosts/recipes.md`, `electron/backend/__tests__/recipe-templates.test.ts`
