---
type: adr
status: accepted
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

# ADR-177: Starting a session from the phone, and showing a terminal grid on it

## Context

ADR-161 shipped remote control: a paired phone can list sessions, read a
session's screen, reply to one, and stop one. Two gaps show up the moment it is
used away from the desk.

**1. The phone can only steer sessions that already exist.** `POST /agents` —
the launch route — is deliberately absent from the remote table, and
`allowlist.test.ts` asserts it stays absent. So the one thing you want when an
idea arrives on the train ("start Claude on the login-flake branch") is the one
thing the surface cannot do. The workaround is to wait until you are back at the
machine, which is exactly the situation remote control exists to remove.

Worth naming plainly, because it decides how much of a widening this is: the
surface *already* grants arbitrary code execution to a device that holds a
send-capable token. `POST /sessions/send` types arbitrary text into a live shell
and presses return. Launching an agent in a workspace the machine already knows
about is a *new route*, not a new category of power — and it is a narrower one
than the route already on the surface, because it cannot choose the command, only
the workspace and the first prompt.

What it does add is a *process* where before there was only typing, so it gets
the same three gates `send` has (capability → `confirmed: true` → audit line)
plus one the existing writes do not need: the target workspace must be one the
machine already knows. `POST /agents` as the local MCP path uses it accepts any
`workspacePath` string and lets the renderer resolve it; that is fine for a
loopback caller who already owns the machine, and not fine for a tunnel.

To choose a workspace the phone first has to *see* the workspaces, and today it
sees no project state at all. `GET /projects` would do it and is the wrong answer:
`ProjectInfo` carries `worktreeStartScript`, `agentCommand`, Linear associations
and every absolute path on the machine. A phone needs a name, a branch, and a
path to launch into.

**2. A terminal grid is unreadable on the phone.** `POST /sessions/read`
returns the daemon's *rendered screen* — a fixed grid, as many columns wide as
the desktop pane is. The client renders it with `white-space: pre-wrap;
overflow-wrap: anywhere` at a fixed 12px, which was a deliberate choice in
ADR-161 ("text hidden off the right edge of a phone is text nobody reads"). It
has an ugly consequence nobody predicted at the time: an agent's UI is *drawn*,
not written. Claude Code's box borders, its diff gutters, its progress lines and
its permission prompts all rely on column alignment. Reflowing a 120-column grid
into ~50 columns of phone breaks every one of those lines in a different place,
and the result reads as garbage — the user's word for it was "garbled". A
transcript that cannot be trusted to show what the screen shows is worse than a
small one.

The fix has to start on the server, because the client cannot know the grid's
width: the payload is a string of lines, and the longest line in a tail is not
the column count.

## Decision

Two independent changes, in one ADR because they are one bug report and both
touch the phone client.

### A. Start a session from the phone

**Read side — a new listener-owned route, `GET /workspaces`.** It joins `GET /me`
and `POST /push/subscribe` in `electron/remote-control/listener-routes.ts`, which
is the file for rows that exist *only* for the phone client, and it hands back a
deliberately narrow projection built from `deps.projectManager.getProjects()`:

```ts
[{ projectId, projectName, workspaces: [{ path, branch, name, isMain }] }]
```

Nothing else. No scripts, no agent command, no issue links, no project root, and
hidden workspaces are filtered out — the phone offers what the sidebar offers.
`LISTENER_OWN_ROUTES` is derived from that table, so the count assertion in
`allowlist.test.ts` becomes three rows, changed on purpose.

**Write side — `POST /agents`, gated four ways.** It joins `REMOTE_WRITE_ROUTES`
(so a read-only device never sees it) and `GUARDED_WRITE_ROUTES` in `server.ts`
(so it needs `confirmed: true` and lands in the audit log). `guardedWrite`'s
body-reading generalizes: `target` reads `body.target ?? body.workspacePath` and
`text` reads `body.text ?? body.prompt`, so a launch audits as the workspace it
launched into and the prompt it seeded, with the prompt hashed exactly as a send
is.

The fourth gate is new and remote-only: before the real handler runs, the guard
checks the requested `workspacePath` against the set of known workspace paths
from `projectManager`. An unknown path is a 403 with an audit line, never a
launch. It lives in `server.ts` rather than in `electron/routes/agents.ts`
because the loopback callers (MCP, CLI) legitimately launch into paths that are
not yet in a project, and taking that away from them is not this ADR's business.

The deny-assertion `it("agent launching")` in `allowlist.test.ts` loses its
`POST /agents` line — deliberately, which is the mechanism that file exists for
— and keeps the `/agents/` prefix line, so rename and delete stay off the
surface. New assertions replace it: launch is absent for a read-only device,
present for a send-capable one, rejected without `confirmed`, and rejected for an
unknown workspace path.

**Client.** The list screen gets a `+` button in the bar, rendered only when
`identity.canSend` — the same "remove, don't disable" rule the composer follows.
It opens a new-session screen: workspaces grouped by project, each row marked if
a session is already running there (computed client-side from the `agents` list
the client already holds), a prompt field, and a Launch button that goes through
the existing `confirmAction` sheet naming the workspace and the prompt. On
success the response carries the new `paneId`; the client re-reads `/agents`,
matches the pane to its agent row, and opens that session's transcript, so
launching lands you where you would have gone anyway.

*Amended by ticket 7.* That last sentence was written as though the agent row
existed by the time the launch returned. It does not: a freshly spawned process
has not reported `SessionStart` to the hook relay yet, so the immediate re-read
loses the race and the client fell back to the list — the launch worked and the
landing did not. The client now *remembers* the launched `paneId` and resolves it
inside `loadAgents()`, which the SSE `status` event and the list poll already
drive, so the session opens on whichever refresh notices it first. The pending
launch expires after 30s and is dropped if the user has opened something else in
the meantime, because a screen that yanks itself elsewhere minutes later is worse
than one that does nothing. Found by ticket 6's own e2e, which now asserts the
auto-open rather than working around its absence.

### B. Show the grid as a grid

**Server.** `POST /sessions/read` adds `cols` and `rows` to its payload — from
the live snapshot's `TerminalSnapshot` when there is one, and from the session's
`meta.json` (`ScrollbackWriter.readMeta`) on the cold path. Additive fields; no
existing caller changes.

**Client.** Stop reflowing. `white-space: pre`, `overflow-x: auto`, and a font
size chosen to fit `cols` columns in the transcript's width: measure the mono
font's per-character advance once with a probe span, then
`size = floor(available / (cols × advanceRatio))`, clamped to a readable floor
and to the current 12px as a ceiling. At or above the floor the whole grid fits
the width and every box border lines up; below it — a 200-column pane on a
390px phone — the floor wins and the transcript pans sideways, which keeps the
alignment that is the whole point. The size is recomputed on resize and rotation
and written to a CSS variable, so a repaint costs one property.

**Verification.** `tests/e2e/remote-control.spec.ts` already drives the client on
a 390×844 viewport, and the fidelity claim is measurable there rather than by
eye: a fake agent draws a box wider than the phone, and the test asserts the
rendered transcript occupies exactly as many visual rows as the payload has
lines. A reflow shows up as more rows than lines, and fails.

## Consequences

**Better.** The phone can start work, not just supervise it. A grid renders as a
grid, so a phone can be trusted to show what the screen shows — which is the
difference between glancing at an agent and having to go and check.

**Harder / riskier.** The remote write surface grows from two routes to three,
and one of them spawns a process. The compensating controls are the four gates
above and the audit line, and the honest framing is the one in Context: a
send-capable token was already an arbitrary-execution capability. Anyone who
finds that trade unacceptable should be revoking send capability, not counting
routes.

`GET /workspaces` is a second projection of project state, which can drift from
`ProjectInfo`. That is the price of not shipping `agentCommand` to a phone, and
it is a projection of four fields.

A tiny-but-aligned transcript is a real tradeoff against a large-but-scrambled
one. It is the right way round for reading an agent's screen at a glance, and the
floor plus horizontal scroll keeps a genuinely wide pane usable rather than
microscopic. Text selection on a panning `<pre>` is fiddlier than on a wrapped
one; nobody copies from this transcript today.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
