---
type: adr
status: proposed
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-178: Always-on remote projects

## Context

The goal: a project can live on a remote box, and every workspace created in that
project is a worktree on that box. Agents and shells keep running when the laptop
lid closes; reopening Manor reattaches as if nothing happened.

ADR-160 (proposed, no tickets started) already designs the core: a `HostTransport`
abstraction, `manor-host remote-bridge` over ssh, remote bootstrap, daemon-side
`exec`/`execStream`, `RemoteBackend`, and a `BackendRegistry` keyed by a per-project
`hostId`. That shape matches the product decision taken here — **one box per project**
— so this ADR builds on ADR-160 rather than replacing it.

But ADR-160 was written for "run on a beefier box while I'm connected". Several of its
choices break precisely in the "laptop closed" case this ADR is about:

1. **Agent hooks.** ADR-160 ticket 10 reverse-forwards the local `AgentHookServer`
   port to the box (`ssh -R`). When the laptop sleeps, the ssh session dies, the
   forward dies, and every hook event an agent fires while the user is away —
   `Stop`, `Notification`, permission prompts — is dropped. On reconnect the
   hook-relay state machine (`electron/hook-relay.ts`, which lives in Electron main)
   has a stale view of every remote agent.
2. **Host-relative paths.** `ProjectManager.worktreePathFor` (`persistence.ts:1128`)
   resolves against the *local* `worktreesDir()` and `expandHome`. `addProject`
   reads `package.json` with local `fs` (`persistence.ts:421`). The teardown script
   runs via local `execAsync` (`persistence.ts:863`).
3. **Backend bypasses** that ADR-160 does not list: `BranchWatcher` stats and reads
   `.git`/`HEAD` with `fs` (`branch-watcher.ts:60-86`); `readBranchSync`
   (`ipc/pty.ts:9`) does the same on every PTY create; `PrewarmManager` talks to the
   local `TerminalHostClient` directly (`prewarm-manager.ts:40-123`).
4. **Getting the project onto the box.** ADR-160 assumes the repo already exists at
   a path on the host. There is no clone flow and no check that the box can reach
   `origin` or has agent CLIs logged in.
5. **Ports.** `LocalPortsBackend` shells out to `/usr/sbin/lsof` — a macOS path. A
   typical remote box is Linux. Even with remote scanning, the webview and portless
   point at `localhost`, so a remote dev server is unreachable without forwarding.
6. **Being away.** ADR-160's UI covers connecting and errors, but not the steady state
   of this feature: the host is unreachable for hours, then comes back — possibly
   after the box rebooted and the remote daemon lost its PTYs.

### Why a provider seam now

Research into managed sandboxes (September 2026) found three credible "persistent
box" providers — Fly Sprites, Daytona, E2B — and ruled out Modal, Vercel Sandbox and
Cloudflare Sandbox (24h caps, or disk resets on sleep) and Codespaces (≤4h idle
timeout). Those providers differ in how you reach the box (ssh vs. SDK/WebSocket
exec), whether they auto-sleep, and whether sleep preserves memory. For now users
**bring their own box** (Hetzner, exe.dev, a Mac mini, Coder — anything reachable
over ssh), but the host spec should be a provider, not a hardcoded ssh target, so a
managed provider is an addition rather than a refactor.

### Persistence model

Design for **disk-only persistence**. A BYO ssh box never sleeps, so this mostly
concerns box reboots and future managed providers. If a remote daemon restarts, its
PTYs are gone but files, scrollback on disk, and agent session ids survive; Manor's
existing resume-on-relaunch (ADR-118, ADR-144) already knows how to bring Claude and
Codex sessions back. Memory-preserving sleep is a provider capability that makes
this path rarer, not a requirement.

## Decision

Build on ADR-160. Implement ADR-160 tickets 1–9 and 11 as written; **replace the
reverse-forward half of ADR-160 ticket 10** (steps 1, 2 and 4) with the hook journal
below, keeping its bootstrap step (3). Then add:

### 1. `HostProvider` seam

`electron/backend/providers/types.ts`:

```ts
interface HostProvider {
  kind: "ssh";                     // later: "sprites" | "daytona" | "e2b"
  capabilities: { autoSleep: boolean; persistsMemory: boolean; previewUrls: boolean };
  ensureUp(): Promise<void>;       // ssh: no-op; managed: start/resume the box
  status(): Promise<HostStatus>;   // "up" | "sleeping" | "unreachable" | "error"
  transport(): HostTransport;      // ADR-160's interface
  forwardPort(remotePort: number): Promise<{ localPort: number; dispose(): void }>;
  previewUrl?(remotePort: number): Promise<string>;
  setBusy?(busy: boolean): void;   // keep-awake hint for autoSleep providers
}
```

`BackendRegistry` (ADR-160 ticket 9) persists `HostSpec = { kind: "ssh", target }`
and constructs a provider from it; `ensureConnected` calls `provider.ensureUp()`
before opening the transport. `SshHostProvider` wraps ADR-160's `SshTransport` and
implements `forwardPort` with `ssh -O forward -L` on the existing ControlMaster.

**Keep-awake rule**, defined now and exercised by the first managed provider: the
registry calls `setBusy(true)` while any pane on that host has an agent in an active
status, and `setBusy(false)` after all are idle. Hosts never sleep mid-task. An agent
waiting on a permission prompt (`requires_input`) counts as busy: under disk-only
persistence, sleeping would kill the waiting agent, and an overnight prompt is exactly
what the user expects to find still waiting in the morning. A managed provider may add
its own idle cap on top if cost demands it.

### 2. Hook journal on the remote daemon

On a remote host, `MANOR_HOOK_PORT` points at a loopback HTTP listener **owned by the
remote daemon**, not at a forward back to the laptop. The hook script
(`~/.manor/hooks/notify.sh`) is unchanged — it curls whatever port it is given.

- The daemon appends each hook payload to a bounded journal
  (`~/.manor/daemon/hook-journal.ndjson`, capped by count and age) with a
  monotonic `seq`, and emits a new `StreamEvent` `{ type: "hookEvent", seq, payload }`
  to connected stream sockets.
- A new control request `{ type: "replayHooks", sinceSeq }` returns journal entries
  after `sinceSeq`.
- Electron main keeps `lastHookSeq` per host. On (re)connect it replays, then feeds
  each payload into the **same** code path `AgentHookServer` uses for local hooks,
  factored out as a single `ingestHookPayload(payload)` function. The hook-relay
  state machine stays in main and stays the single source of truth; notifications
  and `agents.json` updates happen on replay exactly as they would have live.
- Local hosts are untouched: they keep the existing `AgentHookServer` path.

This removes the `AllowTcpForwarding` dependency ADR-160 flagged as a risk.

### 3. Host-relative paths and bypass removal

- Add `homeDir(): Promise<string>` to the backend's shell surface. `worktreePathFor`
  resolves the default worktree root as `<hostHome>/.manor/worktrees/<slug>` and
  expands `~` in `project.worktreePath` against the host's home.
- `addProject` reads `package.json` / lockfiles through `Exec.readFile`.
- `removeWorktree` runs `worktreeTeardownScript` through the backend's exec with
  `cwd` set to the worktree, instead of local `execAsync`.
- `BranchWatcher` and `readBranchSync` read HEAD through the backend
  (`git.currentBranch` or `Exec.readFile`). `readBranchSync` becomes async; its
  callers in `ipc/pty.ts` already run in async handlers.
- `PrewarmManager` resolves its client per host through the registry, and prewarms
  only for local projects in this ADR (remote prewarm costs a round-trip on a
  session the user may never open).

### 4. Remote project onboarding

A new "Add project on a host" flow: pick or add an ssh host, give a repo URL and a
remote directory, and Manor runs `git clone` through `execStream` with progress. It
then runs a **host health check** and shows each result with a fix-it action that
opens a terminal on the box:

| Check | Command | Fix-it |
|---|---|---|
| Reach origin | `git ls-remote --heads origin` | `gh auth login` / add deploy key |
| Claude CLI | `claude --version` + auth probe | `claude setup-token` |
| Codex CLI | `codex --version` | `codex login` |
| GitHub CLI | `gh auth status` | `gh auth login` |

**Credentials never leave the laptop.** Manor does not copy `~/.ssh`, tokens, or
agent credentials to the box, and does not enable ssh agent forwarding (a forwarded
agent is useless while the laptop is closed, and exposes keys to root on the box).
The user authenticates on the box once, in a Manor terminal.

### 5. Remote ports

- `LocalPortsBackend` picks its scanner by `uname`: macOS keeps `lsof`; Linux uses
  `ss -ltnpH` for listeners and `readlink /proc/<pid>/cwd` for the pid→workspace
  mapping. Both run through the injected `Exec`, so remote scanning is free.
- When a remote port is opened in a webview, main calls `provider.forwardPort` and
  routes the webview (and portless, when enabled) to the returned local port.
  Forwards are disposed on disconnect and recreated on reconnect. Where the provider
  supports `previewUrl`, a "copy public URL" action is offered too.

### 6. Away-and-back

- A host that is unreachable is a normal state, not an error toast. Its projects show
  a "disconnected — reconnecting" badge; panes keep the last snapshot visible,
  read-only, with a banner. ADR-169's reconnect backoff drives retries.
- On reconnect: reattach panes via existing snapshots, replay hooks (§2), recreate
  port forwards (§5).
- If the remote daemon's `listSessions` is missing panes Manor expected (the box
  rebooted or the daemon was restarted), those panes go through the existing
  resume-on-relaunch path (ADR-144): a fresh shell in the same cwd, and for panes
  with a known `agentSessionId`, the connector's resume command.

### Out of scope

Managed providers (Sprites, Daytona, E2B) — each is its own ticket or ADR against
`HostProvider`. One box per workspace. Manor-managed billing. Syncing files to a
local editor (Mutagen) and `open_in_editor` for remote paths. Remote MCP servers.

## Consequences

**Better.** Agents genuinely survive the laptop closing, and — unlike ADR-160 alone —
their status, notifications and permission prompts that fired while away are not
lost; replay makes "away" indistinguishable from "watching" in the sidebar history.
Removing the reverse forward removes a class of sshd-config failures. The provider
seam means Sprites/Daytona/E2B support is one new class plus a settings form. The
bypass fixes make every git/fs read go through the backend, which is a correctness
win even for local-only users (one code path instead of two).

**Worse.** The remote daemon grows a second listener (loopback HTTP for hooks) and a
journal file to bound and rotate. Main's hook ingestion gains a replay path whose
ordering against live events must be right — replay must finish before live
`hookEvent`s are applied, or the late-active guard in `hook-relay-transition.ts`
will see events out of order. `readBranchSync` → async touches the PTY create path.
Users must log in to `gh`/`claude` on the box themselves; that is friction, but it
is the price of not shipping credentials to a machine Manor doesn't control.

**Risks.** The journal is a record of agent activity on disk on the box — it contains
tool names and prompts in some hook payloads. It lives under the user's home with
0600 permissions and is capped; that is the same exposure as the agents' own
transcripts on that box, but it should be noted in docs. Linux port scanning via
`/proc` needs the same user as the dev server; servers run as another user won't be
attributed to a workspace. Replaying a large backlog after a long absence could fire
a burst of notifications — replay should coalesce notifications per agent to the
latest state. Everything here is blocked on ADR-160 landing first; if ADR-160 stalls,
so does this.

## Tickets

Prerequisite: ADR-160 tickets 1–9 and 11. ADR-160 ticket 10 is amended by ticket 3
below (bootstrap kept, reverse forward dropped).

Ticket 8 landed its docs in `docs/remote-hosts.md` (one doc for ADR-160 and this
ADR, not a separate `docs/remote-projects.md`). The E2E harness is a private
unprivileged sshd on macOS plus a Linux container mode
(`scripts/test-remote-e2e.mjs [--docker]`); ADR-160 ticket 12's reverse-hook
bullet is covered by the hook-journal scenarios instead.

<div data-type="database" data-path="." data-view="board"></div>
