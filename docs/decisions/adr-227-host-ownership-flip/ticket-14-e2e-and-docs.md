---
title: E2E for the ownership flip, and docs
status: todo
priority: high
assignee: sonnet
blocked_by: [6, 8, 9, 10, 11, 12, 13]
---

# E2E for the ownership flip, and docs

## E2E
Extend `tests/e2e/host-server.spec.ts`, or add
`tests/e2e/host-ownership.spec.ts`. Run it with
`node scripts/test-remote-e2e.mjs --playwright-only`. The flow:

1. **Adoption.** Seed a desktop with a remote project that has workspace
   names, a folder and a linked issue. Connect, and assert:
   - the box's `projects.json` has them;
   - the desktop's `projects.json` no longer does;
   - the backup file exists;
   - the sidebar is unchanged.
2. **Lid closed.** Kill the desktop's ssh with `killAppSsh`. The phone,
   paired to the host server:
   - creates a worktree (the setup script runs);
   - launches an agent with a prompt in it;
   - sees status change to working, then to requires-input.
3. **Box CLI.** Still with the lid closed, `manor list-workspaces` on the box
   lists the new worktree.
4. **Reconnect.** The desktop reconnects. The workspace, its agent tab and
   the agent show up in the desktop's sidebar with the right status, without
   a restart.
5. **GitHub.** With `installFakeGh` on the box (via `installRemoteStubs`), a
   PR badge shows for the new workspace on both phone and desktop.

## Docs
- **`CONTEXT.md`:**
  - **Host server**: now the authority for its host.
  - **Owner channel**: no manifest or layout push; adoption plus events.
  - Add **Adoption**.
  - **Host**: the desktop is a client of each host server.
- The remote hosts doc page: what moved onto the box, the backup file, `gh`
  on the box, "Use Linear on \<host\>", and the Linear MCP alternative.
- Mark ADR-225's slice-2 bullet list as done by ADR-227 (one line).

## Files to touch
- `tests/e2e/host-ownership.spec.ts` (new), or
  `tests/e2e/host-server.spec.ts`
- `tests/e2e/helpers/remote-host.ts`
- `CONTEXT.md`
- `docs/` (the remote hosts page)
- `docs/decisions/adr-225-host-server/index.md`

## Small cleanups carried over from ticket 4
- **Unused prop:** `MiniTerminal`'s `attach` prop has no caller left. Remove
  it.
- **Optional layout store in `spawnPane`:** it uses `deps.layoutStore?.`
  because the pty test fakes (`pty-host`, `ipc-transport`, `ws-bridge`) have
  no layout store. Give those fakes one, and drop the optional chaining.
- **Failed setup scripts:** the Setup tab reports "done" whatever the exit
  code. Report a failed script, using the exit code from the exit event.
- **Reopen stack:** an auto-closed Setup tab goes onto the workspace's reopen
  stack. Keep it off.

## Carried over from ticket 5
- **The phone flow in the spec is a minimal fix.** Ticket 5 changed
  `tests/e2e/host-server.spec.ts` to reach the agent through the bridge API,
  because an unadopted host has no projects. After adoption, go back to
  driving the phone through the sidebar.
- **The daemon test harness doesn't support `writeAfterReady`.** As a result,
  `device-launch.test.ts` doesn't see the launch line being typed. Add the
  support, and assert that the line is typed.
- **A known failure that predates this branch.** `remote-host.spec.ts`
  "laptop closed … one notification" sends 2 notifications instead of 1. It
  fails on main too. Note it if it is still failing.

## Carried over from ticket 6
- **Make adoption an explicit step in the spec.** The spec passes only
  because the owner channel's empty adoption lands before the spec adds its
  project. Make adoption an explicit, awaited step.
- **Adopted agents that are still active.** The host doesn't reconcile them
  at once. One whose pane is gone is only abandoned at the next boot sweep.
  Test for this, or make adopt run `reconcileStaleAgents`.
