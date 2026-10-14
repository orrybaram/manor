---
title: Docs, struck limits and ADR-231's known limits
status: todo
priority: medium
assignee: sonnet
blocked_by: [1, 4, 5, 7, 8, 9, 11]
---

# Docs, struck limits and ADR-231's known limits

ADR-231 D7.

## What to write

- **`docs/remote-hosts.md#testing`:**
  - the `--k8s` mode: what it needs (Docker), what it downloads and where,
    `MANOR_E2E_K8S_KEEP`, and the `sg docker` note for this kind of
    machine;
  - a bullet for `recipe-kubernetes.e2e.test.ts`, listing its scenarios
    and what it leaves to the Docker suite;
  - bullets for `lid-closed.spec.ts`, `recipe-host.spec.ts`,
    `host-restore-asleep.spec.ts`, `host-idle-stop.spec.ts` (slow, and how
    to skip it) and the drop-grace test;
  - the flake: remove the "Seen flaky" paragraph and the two
    "laptop closed" rows if ticket 1's counts allow (10 of 10 on the
    private sshd, 4 of 4 in `--docker`). Otherwise keep the row with
    what's left.
- **`docs/remote-hosts.md#asleep-hosts`:** check that the wording still
  matches what was tested. For example, a pod restarting is no longer
  "asleep".
- **`docs/hosts/recipes.md#kubernetes`:** replace "haven't been run against
  a cluster" with the kind version and Kubernetes version it passed on,
  and what kind can't promise (managed clusters' storage classes, Pod
  Security admission). Describe `status`'s behavior while a pod restarts.
- **Struck through, with "Fixed/Covered in ADR-231":**
  - ADR-229's "The Kubernetes template was syntax-checked only";
  - ADR-230's three "E2E gaps" entries (D3, D1, D5);
  - ADR-230's "Flaky tests" laptop-closed entry.
- **ADR-231 `index.md`:**
  - **"Known limits as built"**, from what the tickets found and their
    "Found" sections;
  - what stayed unit-only and why: D1's forwarded class, D5's moved calls,
    no shorter idle stop;
  - the lid-closed finding about a frozen desktop's pairing, if ticket 5
    marked it `test.fail`;
  - every template bug the cluster found.
- **Status.** Set the ADR's `status: accepted` only after the integration
  verification passes.

## Run before writing

- `pnpm typecheck`, `pnpm lint` and `pnpm test:unit`. Compare against the
  baseline failures.
- `sg docker -c 'node scripts/test-remote-e2e.mjs --recipe'` and `--k8s`.
- `DISPLAY=:0 node scripts/test-remote-e2e.mjs --playwright-only` and
  `--docker --playwright-only`. Record new failures against the
  known-failures table.

## Files to touch
- `docs/remote-hosts.md`
- `docs/hosts/recipes.md`
- `docs/decisions/adr-229-hosts-we-start/index.md`
- `docs/decisions/adr-230-host-hardening/index.md`
- `docs/decisions/adr-231-host-validation/index.md`
