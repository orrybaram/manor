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

# ADR-144: Resume the prior agent session on relaunch instead of starting fresh

## Context

When Manor relaunches, persisted panes are reconciled against the running PTY
daemon (`electron/terminal-host/layout-persistence.ts:219` `reconcile()`), which
sorts each pane into one of three buckets:

- **warm** — the daemon still holds the live PTY session. Manor reattaches to the
  running process, so the agent (Claude/Codex/etc.) is *literally the same
  process*. It looks perfectly resumed because it is.
- **cold** — the daemon lost the session but a scrollback file exists. Manor
  renders the old scrollback *text* into a brand-new PTY at the old cwd.
- **fresh** — nothing survived; new PTY.

For cold/fresh panes the agent process is gone. The renderer then runs the
interrupted-task relaunch path in `src/hooks/useTerminalLifecycle.ts:287-299`:

```ts
const resumeTask = activeTasks.find(
  (t) => t.paneId === paneId && !t.resumedAt && t.agentCommand,
);
...
sendOnShellReady(resumeTask.agentCommand!);   // runs e.g. `claude --dangerously-skip-permissions` VERBATIM
```

This re-executes the *bare* agent command, which starts a **brand-new agent
session** — the prior conversation is lost. This is why users see inconsistent
behavior: warm restores keep the live session (great), but after a full machine
reboot or daemon restart (cold/fresh) the session silently starts over.

We already track everything needed to fix this:

- `TaskInfo.agentSessionId` (`electron/task-persistence.ts:36`) is the agent
  CLI's real session UUID (Claude's `session_id`, Codex's session id, etc.). It
  is captured from the hook payload at `electron/hook-relay-effects.ts:112`
  (`agentSessionId: effect.sessionId`), is **non-null by construction**, immutable,
  and persisted to `~/.manor/tasks.json`.
- A connector abstraction already exposes `getResumeCommand(baseCommand, sessionId)`
  on every agent (`electron/agent-connectors.ts:26`).

But that abstraction is **dead code** — `getResumeCommand` is defined and never
called from anywhere in the codebase. And its current implementations have gaps:

- **Claude** rebuilds from the binary only (`claude --resume <id>`), *dropping*
  the user's flags like `--dangerously-skip-permissions` — so the resumed session
  re-prompts for permissions.
- **Codex** ignores the session id entirely and uses `codex resume --last`
  (imprecise — resumes whatever the most-recent session was, not this pane's).
- **opencode** has **no connector class at all**; `getConnector("opencode")`
  falls back to the Claude connector, so it would emit `--resume`, which opencode
  does not understand (opencode uses `--session <id>`).
- **pi** uses `pi --session <id>` (plausible but unverified).

### Why no `-r` picker fallback

`agentSessionId` is non-null whenever a `TaskInfo` exists, and a `TaskInfo` only
exists once the agent emitted a hook event. So in *every* case where resuming is
meaningful, we have a concrete UUID. The only time we lack one is when there is no
task at all (a pane that never ran an agent / a genuinely fresh shell) — and there
the correct behavior is exactly today's: run the bare command. An interactive
`-r` session picker is therefore unnecessary as an automatic fallback.

## Decision

Wire the existing connector resume abstraction into the relaunch path, and fix the
abstraction so it is correct for all four agent kinds.

### 1. Make `getResumeCommand` preserve flags + guard against double-append

Change the contract from "rebuild from binary" to **"preserve the full base
command and append the agent-specific resume flag."** This keeps user flags
(`--dangerously-skip-permissions`, `--yolo`, model overrides, etc.). Add a shared
guard so we never double-append when the base command already specifies resume.

Per-agent resume syntax (verified against current CLIs, June 2026):

| Agent    | Resume command                       | Existing resume tokens to detect (skip append) |
|----------|--------------------------------------|------------------------------------------------|
| claude   | `<base> --resume <id>`               | `--resume`, `-r`, `--continue`, `-c`           |
| codex    | `<binary> resume <id>`               | `resume` subcommand                            |
| opencode | `<base> --session <id>`              | `--session`, `-s`, `--continue`, `-c`          |
| pi       | `<base> --session <id>`              | `--session`                                    |

Notes:
- `getResumeCommand` returns `null` when `sessionId` is empty (defensive; in
  practice it is always present) so callers can fall back to the bare command.
- Codex's resume is a *subcommand*, not a flag, and top-level flags like `--yolo`
  don't compose cleanly after it — so codex stays a binary+`resume <id>` rebuild.
  The approval-mode flag is not re-applied on codex resume; documented as a known
  limitation (follow-up, not in scope).
- Add a new **`OpencodeConnector`** and register it in `ensureDefaults()` so
  opencode no longer falls through to Claude.

### 2. Expose resume-command construction to the renderer over IPC

Connectors live in the main process. Add `tasks:buildResumeCommand(taskId)` in
`electron/ipc/tasks.ts`, mirroring the `tasks:markResumed` pattern. It looks up the
task, calls `getConnector(task.agentKind).getResumeCommand(task.agentCommand,
task.agentSessionId)`, and returns `string | null`. Surface it through
`electron/preload.ts` and `src/electron.d.ts` as
`tasks.buildResumeCommand(taskId): Promise<string | null>`.

### 3. Use it in the relaunch path

In `src/hooks/useTerminalLifecycle.ts`, replace the bare relaunch with the resume
command, falling back to the bare command if the IPC returns `null`:

```ts
const resumeCmd = await window.electronAPI.tasks.buildResumeCommand(resumeTask.id);
void window.electronAPI.tasks.markResumed(resumeTask.id);
sendOnShellReady(resumeCmd ?? resumeTask.agentCommand!);
```

This is the *only* behavioral change to the recovery flow; warm restore is
untouched.

## Consequences

**Better**
- Cold/fresh-restored panes resume the actual prior conversation across machine
  reboots and daemon restarts — matching the warm-restore experience.
- Claude resumes keep `--dangerously-skip-permissions`, so no re-prompting.
- opencode gets a real connector; codex resumes the *specific* pane's session.
- The previously-dead `getResumeCommand` abstraction becomes live and tested.

**Harder / risks**
- **Claude session forking**: recent Claude versions fork a resumed session into a
  *new* `session_id`. The relay handles this — the new SessionStart hook creates a
  fresh `TaskInfo` (with the base `agentCommand` from pane context) and retires the
  old pane task, while `resumedAt` on the old task prevents double-launch. The next
  relaunch then resumes from the new session id. The chain is self-correcting, but
  it means the resumed id differs from the original; acceptable.
- **Codex approval mode** (`--yolo`) is not re-applied on resume; a codex pane may
  re-prompt. Documented limitation, follow-up if it bites.
- **pi** resume syntax (`--session`) is inherited from the existing connector and
  remains unverified against a live pi CLI; low blast radius (returns a command
  that, if wrong, the user sees immediately and can correct).
- If `buildResumeCommand` ever returns `null` (no session id / unsupported agent),
  behavior is exactly today's bare-command relaunch — no regression.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
