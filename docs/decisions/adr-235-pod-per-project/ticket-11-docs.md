---
title: Docs and glossary — profiles, pods per project, sign-in trade-off
status: done
priority: medium
assignee: sonnet
blocked_by: [4, 6, 7, 10, 12]
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

## Follow-ups from ticket 10
- The release `host-image` job now builds the app and the host tarball on ubuntu-latest. It hasn't run in CI yet. Check the first tag's run: does `pnpm install` (electron-rebuild postinstall) succeed, and does the arm64 compile under QEMU finish within 90 minutes? Use `--ignore-scripts` if the postinstall breaks.
- The tarball is built twice, on macOS in `release` and on Ubuntu in `host-image`. Optional: build it once and pass it between the jobs as an artifact.

## Notes from ticket 9
- Sign-in needs kubectl 1.20 or later (`--patch-file /dev/stdin`) and macOS or Linux.
- Check against a real cluster, ideally in the recipe-kubernetes e2e: does `gh auth setup-git` work in a pod with only `GH_TOKEN` set and no gh config? The step can fail without failing `up`.

## Notes from ticket 12
- A new profile shows no sign-in section until it has been saved and reopened, because sign-in needs a profile id. The docs should say: save the profile, then turn on sign-in.
