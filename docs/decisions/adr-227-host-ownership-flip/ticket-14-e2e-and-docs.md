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

## Carried over from ticket 8

- **Moving a project back off an adopted host ends its panes there**, because the host's `projects.remove` tears down its layout; the layout is not carried along, and `hostPaths` (the remembered path) is lost after adoption. A transfer onto an adopted host doesn't carry the source's main-workspace name and issues. Fix or document as a known limit.
- **Detached-window claims** for a remote workspace are lost: `reportViewport` is forwarded with an owner origin and a host has no windows. Keep viewport claims on the desktop.
- **Each remote pane mount costs one extra round trip** (host `pty.create` before the daemon attach). Deliberate, so the host can deliver pending commands; note it in the docs.
- The remote e2e stub agent (`tests/e2e/remote-host/manor-e2e-agent`) now ends with `exec awk`; a foreground shell reads as "agent process exited". Note it in the e2e docs.
- `remote-host.spec` "laptop closed … one notification" now passes on this branch (it fails on main).

## Carried over from ticket 9

- **Legacy boxes regress.** A box with no host server (or an old one) now gets no agent status, chat or worktree polling on the desktop, and no last-known workspaces while away; `removeProject` for such a project while its host is away only tears down the main path's layout. This follows D4's deletions; document it in the ADR's Consequences and the user docs (upgrade the box).
- `ChatMirror`'s `unwatchedPollIntervalMs` path is now unused in production; remove it if knip doesn't need it.
- Two `read-state.spec` tests assert `app.dock.getBadge()`, which is macOS-only; they fail on Linux. Confirm they fail on main too and add to the known-failures note (or skip them off macOS).

## Carried over from ticket 10

- **"gh isn't signed in on <host>" in the sidebar.** `usePrWatcher` already records the state in `useGhHostStore` (`src/lib/gh-host-status.ts`), but only `TasksView` shows it. Add a small sidebar notice near the PR badges that reads the store.
- `GitHubNudge`, `GitHubIntegrationSection` and `useIssuesShortcut` still call `checkStatus()` for the local machine only; the tracker's `statusQuery` is global. Pass the project's host where it matters (`checkStatus(hostId)` routes with `byHost`).
- **`github.proxyImage` stays local**, so a remote project's private-repo images use the laptop's `gh` sign-in. Route it to the host (add a route rule by project/host) or document it.
- `createIssue` and `listRepos` stay `LOCAL_ROUTE` (no `GhRepo` arg). Document, or give them a host argument.
- No e2e for the gh empty state (no remote fake-`gh` fixture). Add one if cheap.
- Known local e2e failures on the pre-ticket-10 commit too: `pr-badge-matrix` ("g-queued-mergequeue readiness" expects queued, gets ready) and `sidebar-pr-tweaks`. Confirm against main and add to the known-failures note.
- The remote e2e runner needs `DISPLAY=:0` on this box; note it in the e2e docs.

## Carried over from ticket 11

- No e2e covers the "Use Linear on <host>" toggle; the fake host server has no Linear. Add one only if a Linear GraphQL stub is cheap.
- `docs/remote-hosts.md` already covers host-native `gh`, the Linear opt-in and the Linear MCP alternative; keep it in sync with the rest of the docs pass.

## Carried over from ticket 12

- **Add a remote e2e where the phone, on a host server, creates a workspace and launches an agent.** The existing remote e2e doesn't cover that path (D6's headline).
- There is no phone issue picker in the composer today. If one is built, show "turn Linear on in desktop settings" when `linear.isConnected` is false or a `linear.*` call is refused with `unavailable:host`.
- `NewWorkspaceDialog.tsx`'s `<form>` is still indented for the removed ternary; reformat it.
- phone-chat "slash menu lists built-ins and skills" flaked once in a batch run (passed alone). Watch it.
