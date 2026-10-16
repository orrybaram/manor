---
title: Kubernetes template — ingress-deny NetworkPolicy and labels
status: done
priority: medium
assignee: haiku
blocked_by: []
---

# Kubernetes template — ingress-deny NetworkPolicy and labels

ADR-235 D8. **Prerequisite outside this ADR:** ADR-234 ticket 5 changes the
same `kubernetes.ts`. Start from its version.

- Pod template labels: add `app.kubernetes.io/managed-by: manor` and
  `manor.sh/host: $name`, next to `app: $name`.
- In `up.sh`, after the namespace step, `kubectl apply` a NetworkPolicy
  `manor-deny-ingress` (podSelector on the managed-by label, `policyTypes:
  [Ingress]`, `ingress: []`). It is idempotent, so applying it on every `up`
  is fine.
- `destroy.sh` leaves the policy in place: it is shared by the namespace.
- Update `recipe-templates.test.ts` content assertions.

## Files to touch
- `electron/backend/providers/recipe-templates/kubernetes.ts`
- `electron/backend/providers/recipe-templates.test.ts` (or wherever the template tests live)
