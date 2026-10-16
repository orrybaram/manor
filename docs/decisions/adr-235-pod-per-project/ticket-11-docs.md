---
title: Docs and glossary — profiles, pods per project, sign-in trade-off
status: todo
priority: medium
assignee: sonnet
blocked_by: [4, 6, 7, 9, 10]
---

# Docs and glossary — profiles, pods per project, sign-in trade-off

ADR-235, all slices.

- `docs/hosts/recipes.md`:
  - a "Host profiles" section: what a profile saves, perHost fields, edits
    affecting only new hosts, and the default idle stop of 60 minutes;
  - a "A project in its own pod" section: the Add Project / Set up on
    entries, naming, failure handling (kept host, Retry, Delete), and
    removal;
  - the NetworkPolicy, and that it needs a policy controller.
- `docs/remote-hosts.md` "Your credentials stay on your laptop": add the
  opt-in exception for Kubernetes profiles (D9), with the trade-off stated
  plainly, next to the existing Web Push and Linear exceptions.
- `CONTEXT.md`: glossary entries for **Host profile** and **Project's pod**
  (`forProject`).
- Update any e2e specs and helpers that the Add Project host select changes
  (see the `e2e-on-this-wsl-box` memory for running them).

## Files to touch
- `docs/hosts/recipes.md`
- `docs/remote-hosts.md`
- `CONTEXT.md`
- e2e specs touching `AddProjectDialog` (if any)
