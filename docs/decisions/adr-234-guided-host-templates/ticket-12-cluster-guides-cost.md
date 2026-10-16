---
title: "Where's your cluster?" guides, kubeconfig watcher, disk cost note
status: todo
priority: low
assignee: sonnet
blocked_by: [11]
---

# "Where's your cluster?" guides, kubeconfig watcher, disk cost note

ADR-234 D13 (slice 4).

- When `checkTemplate("kubernetes")` returns no contexts, the Connect step
  shows three cards (reuse the Where step's path-card styles): already have
  one (choose a kubeconfig file → set `KUBECONFIG` for this recipe's env),
  a cloud cluster (GKE Autopilot, DigitalOcean: `Link`s to their docs plus
  the one login command), a practice cluster (Docker Desktop / OrbStack, with
  "the Docker template is simpler on this computer").
- Main watches the kubeconfig path(s) (`fs.watch`, debounced) while
  subscribed; the renderer re-runs `checkTemplate` on change and leaves the
  cards when a context appears.
- Cost note: the storage check's detail and a Kubernetes host's row (when
  its cluster server looks like a managed cloud — GKE/EKS/AKS/DO hostnames)
  say "The disk keeps billing while the host is stopped."

## Files to touch
- `src/components/settings/HostsPage/StartHostForm.tsx` (+ a `ClusterGuide` component)
- `electron/backend/providers/recipe-templates/checks/kubernetes.ts`
- IPC wiring for the watcher, `HostRow.tsx` for the cost note, tests
